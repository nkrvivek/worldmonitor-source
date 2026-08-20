import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeUnavailableSeedMeta } from '../scripts/_seed-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const seedSrc = readFileSync(join(root, 'scripts/seed-supply-chain-trade.mjs'), 'utf-8');
const healthSrc = readFileSync(join(root, 'api/health.js'), 'utf-8');
const registrySrc = readFileSync(join(root, 'worker/seeds/registry.ts'), 'utf-8');
const thresholdsSrc = readFileSync(
  join(root, 'server/worldmonitor/resilience/v1/_standalone-source-thresholds.ts'),
  'utf-8',
);

// Four fetchers in seed-supply-chain-trade.mjs go through wtoFetch, which returns
// null before it issues a request when WTO_API_KEY is unset. The Worker holds no
// such secret, so on 2026-08-06 none of them had ever run — and nothing said so.
// Three layers hid it, and this file pins the fix to each:
//
//   1. The branches resolve to null instead of rejecting, so Promise.allSettled
//      reports `fulfilled` and the "Barriers failed" warning never printed. The
//      seeder writes seed-meta with sourceState 'unavailable' now, which health
//      reads as NOT_CONFIGURED — visible, never an alarm, and it flips to OK by
//      itself the moment the credential lands.
//   2. Two of the three keys had no health row at all. They only ever appeared
//      in _standalone-source-thresholds.ts, which no operator reads.
//   3. The seeder still reports OK because FRED shipping and Treasury customs
//      succeed beside the dead branches, so the fleet-wide coverage audit
//      (docs/solutions/integration-issues/seed-coverage-gap-after-the-railway-move.md)
//      never looked at it — that audit only caught seeds writing nothing at all.
//
// Bounds: TRADE_TTL is 8h and the cron is every 6h, so maxStaleMin must sit in
// [TTL, TTL+120] (no silent EMPTY window, no false STALE) and at or above the
// cron interval (no alarm on a healthy producer).
const CRON_INTERVAL_MIN = 360;

/** @param {string} varName */
function extractSeconds(varName) {
  const m = seedSrc.match(new RegExp(`const\\s+${varName}\\s*=\\s*(\\d+)`, 'm'));
  if (!m) throw new Error(`could not find ${varName} in scripts/seed-supply-chain-trade.mjs`);
  return Number(m[1]);
}

/** @param {string} name */
function extractMaxStaleMin(name) {
  const m = healthSrc.match(new RegExp(`\\b${name}:\\s*\\{[^}]*?maxStaleMin:\\s*(\\d+)`, 'ms'));
  if (!m) throw new Error(`could not find ${name}.maxStaleMin in api/health.js`);
  return Number(m[1]);
}

// Data key → the health row that reads its seed-meta. Every key the seeder lists
// in WTO_GATED_KEYS must appear here, and the first test below proves it.
const GATED = [
  { dataKey: 'trade:barriers:v1:tariff-gap:50', healthRow: 'tradeBarriers' },
  { dataKey: 'trade:restrictions:v1:tariff-overview:50', healthRow: 'tradeRestrictions' },
  { dataKey: 'trade:tariffs:v1:840:all:10', healthRow: 'tariffTrendsUs' },
];

describe('the WTO-gated keys are the ones health can read', () => {
  it('WTO_GATED_KEYS names exactly the keys with a health row', () => {
    const m = seedSrc.match(/const WTO_GATED_KEYS = \[(.*?)\]/s);
    assert.ok(m, 'could not find WTO_GATED_KEYS in scripts/seed-supply-chain-trade.mjs');
    const listed = m[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
    const expected = ['KEYS.barriers', 'KEYS.restrictions', 'KEYS.tariffTrendsUs'].sort();
    assert.deepEqual(
      listed,
      expected,
      'a key added to WTO_GATED_KEYS with no health row writes a seed-meta nobody reads, ' +
        'and a key dropped from it goes back to reporting EMPTY when the truth is "no credential".',
    );
  });

  it('the seeder writes an unavailable meta when WTO_API_KEY is unset', () => {
    assert.match(
      seedSrc,
      /if \(!process\.env\.WTO_API_KEY\) \{[\s\S]*?for \(const key of WTO_GATED_KEYS\) await writeUnavailableSeedMeta\(key\)/,
      'without this the branches leave no trace at all: wtoFetch returns null before the ' +
        'request, the guarded writes are skipped, and the seeder reports OK on shipping alone.',
    );
  });

  for (const { dataKey, healthRow } of GATED) {
    it(`${healthRow} does not alarm on a healthy 6-hourly seed`, () => {
      assert.ok(
        extractMaxStaleMin(healthRow) >= CRON_INTERVAL_MIN,
        `${healthRow}.maxStaleMin is ${extractMaxStaleMin(healthRow)} against a ` +
          `${CRON_INTERVAL_MIN}min cron: health reports STALE while the producer is working.`,
      );
    });

    it(`${healthRow} opens no silent EMPTY window past TRADE_TTL`, () => {
      const ttlMin = extractSeconds(dataKey.startsWith('trade:tariffs') ? 'TARIFF_TTL' : 'TRADE_TTL') / 60;
      const maxStale = extractMaxStaleMin(healthRow);
      assert.ok(
        maxStale >= ttlMin && maxStale <= ttlMin + 120,
        `${healthRow}.maxStaleMin (${maxStale}) is outside [${ttlMin}, ${ttlMin + 120}]: below it ` +
          'health alarms STALE before the data even expires; above it the key is gone while ' +
          'health still reads OK.',
      );
    });

    it(`${healthRow} and the standalone-source threshold agree on ${dataKey}`, () => {
      const metaKey = `seed-meta:${dataKey}`;
      const m = thresholdsSrc.match(new RegExp(`'${metaKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*(\\d+)`));
      if (!m) return; // not every health row is a CRI input; only pin the ones that are
      assert.equal(
        Number(m[1]),
        extractMaxStaleMin(healthRow),
        `${metaKey} would be marked stale on a different schedule than health uses, so the ` +
          'resilience scorer and the operator would disagree about the same key.',
      );
    });
  }

  it('is registered on the 6-hourly cron every bound above is derived from', () => {
    const m = registrySrc.match(/cron: '([^']+)',\s*scripts: \['scripts\/seed-supply-chain-trade\.mjs'\]/);
    assert.ok(m, 'could not find the seed-supply-chain-trade entry in worker/seeds/registry.ts');
    assert.equal(
      m[1],
      '0 */6 * * *',
      `the seeder moved to '${m[1]}'. CRON_INTERVAL_MIN here is ${CRON_INTERVAL_MIN}; move it ` +
        'and re-derive every bound above.',
    );
  });
});

describe('writeUnavailableSeedMeta says "never configured", not "empty"', () => {
  const ENV = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
  /** @type {Record<string, string | undefined>} */
  let saved = {};
  /** @type {typeof globalThis.fetch} */
  let realFetch;
  /** @type {unknown[]} */
  let sent;

  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    realFetch = globalThis.fetch;
    sent = [];
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ result: 'OK' }) };
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('writes recordCount 0 and sourceState unavailable to the derived meta key', async () => {
    const ok = await writeUnavailableSeedMeta('trade:barriers:v1:tariff-gap:50');
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    const [cmd, key, body] = sent[0];
    assert.equal(cmd, 'SET');
    assert.equal(key, 'seed-meta:trade:barriers:v1:tariff-gap:50');
    const meta = JSON.parse(body);
    assert.equal(meta.recordCount, 0);
    assert.equal(
      meta.sourceState,
      'unavailable',
      "api/health.js reads exactly this string for NOT_CONFIGURED; anything else warns or crits.",
    );
  });

  it('leaves sourceState off an ordinary meta write', async () => {
    const { writeSeedMeta } = await import('../scripts/_seed-utils.mjs');
    await writeSeedMeta('trade:barriers:v1:tariff-gap:50', 12);
    const meta = JSON.parse(sent[0][2]);
    assert.equal(
      'sourceState' in meta,
      false,
      'an absent sourceState means ok — adding one to every write would change what every ' +
        'existing caller reports.',
    );
  });
});
