import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const seedSrc = readFileSync(join(root, 'scripts/seed-economy.mjs'), 'utf-8');
const healthSrc = readFileSync(join(root, 'api/health.js'), 'utf-8');
const registrySrc = readFileSync(join(root, 'worker/seeds/registry.ts'), 'utf-8');
const freshnessSrc = readFileSync(join(root, 'scripts/regional-snapshot/freshness.mjs'), 'utf-8');

// seed-economy.mjs was written when it ran every 6 hours. The Worker port moved
// it to `0 9 * * *` and left four TTLs and three health bounds behind. Measured
// 2026-08-06, 750 minutes after a healthy seed: economicStress EMPTY,
// macroSignals EMPTY_ON_DEMAND, energyPrices EMPTY. ENERGY_TTL was 3600 — the
// key existed for one hour in twenty-four.
//
// Three rules, and they are not the same rule the tariff test enforces.
// tests/trade-policy-tariffs.test.mjs pins maxStaleMin to a band around the TTL
// [TTL, TTL+120]. Its lower bound is not universal: the weekly EIA keys in this
// same seeder carry a 21-day TTL against a 14-day bound on purpose, because
// those TTLs are sized to how often EIA publishes, not to the cron. What
// generalizes is the cron interval — a producer that runs once a day cannot
// keep anything fresher than once a day.
//
//   1. maxStaleMin <= TTL_min + 120 — no silent EMPTY window (the 2026-04-27
//      incident: data key gone, seed-meta still fresh, health reads OK).
//   2. TTL_min >= CRON_INTERVAL_MIN — the data must outlive the gap between runs.
//   3. maxStaleMin >= CRON_INTERVAL_MIN — no STALE alarm on a healthy producer.
const CRON_INTERVAL_MIN = 1440;

/** @param {string} varName */
function extractSeconds(varName) {
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*(\\d+)`, 'm');
  const m = seedSrc.match(re);
  if (!m) throw new Error(`could not find ${varName} in scripts/seed-economy.mjs`);
  return Number(m[1]);
}

/** @param {string} name */
function extractMaxStaleMin(name) {
  const re = new RegExp(`${name}:\\s*\\{[^}]*?maxStaleMin:\\s*(\\d+)`, 'ms');
  const m = healthSrc.match(re);
  if (!m) throw new Error(`could not find ${name}.maxStaleMin in api/health.js`);
  return Number(m[1]);
}

/** @param {string} key */
function extractMaxAgeMin(key) {
  const re = new RegExp(`key: '${key}',[^}]*?maxAgeMin:\\s*(\\d+)`, 'ms');
  const m = freshnessSrc.match(re);
  if (!m) throw new Error(`could not find ${key} maxAgeMin in regional-snapshot/freshness.mjs`);
  return Number(m[1]);
}

// Every TTL in seed-economy.mjs that is sized to the cron rather than to an
// upstream publication cadence, with the health row that must move with it.
// energyCapacity has no health row today; it still owes rule 2.
const CRON_SIZED = [
  { ttlVar: 'MACRO_TTL', healthRow: 'macroSignals' },
  { ttlVar: 'STRESS_INDEX_TTL', healthRow: 'economicStress' },
  { ttlVar: 'ENERGY_TTL', healthRow: 'energyPrices' },
  { ttlVar: 'FRED_TTL', healthRow: 'fredBatch' },
  { ttlVar: 'CAPACITY_TTL', healthRow: null },
];

describe('seed-economy runs daily, and everything sized to its cadence must say so', () => {
  it('is registered on a daily cron — the number every bound below is derived from', () => {
    const re = /cron: '([^']+)',\s*scripts: \['scripts\/seed-economy\.mjs'\]/;
    const m = registrySrc.match(re);
    assert.ok(m, 'could not find the seed-economy entry in worker/seeds/registry.ts');
    assert.equal(
      m[1],
      '0 9 * * *',
      `seed-economy moved to '${m[1]}'. CRON_INTERVAL_MIN in this test is ${CRON_INTERVAL_MIN}; ` +
        'move it and re-derive every TTL and maxStaleMin below.',
    );
  });

  for (const { ttlVar, healthRow } of CRON_SIZED) {
    it(`${ttlVar} outlives the gap between runs`, () => {
      const ttlMin = extractSeconds(ttlVar) / 60;
      assert.ok(
        ttlMin >= CRON_INTERVAL_MIN,
        `${ttlVar} is ${ttlMin}min against a ${CRON_INTERVAL_MIN}min cron: the key dies ` +
          `${CRON_INTERVAL_MIN - ttlMin}min before the next run and the endpoint serves nothing ` +
          'until then, while seed-meta (7-day TTL) still reads healthy.',
      );
    });

    if (!healthRow) continue;

    it(`${healthRow}.maxStaleMin does not alarm on a healthy daily seed`, () => {
      const maxStale = extractMaxStaleMin(healthRow);
      assert.ok(
        maxStale >= CRON_INTERVAL_MIN,
        `${healthRow}.maxStaleMin is ${maxStale} against a ${CRON_INTERVAL_MIN}min cron: ` +
          'health reports STALE while the producer is working normally.',
      );
    });

    it(`${healthRow}.maxStaleMin opens no silent EMPTY window past ${ttlVar}`, () => {
      const ttlMin = extractSeconds(ttlVar) / 60;
      const maxStale = extractMaxStaleMin(healthRow);
      assert.ok(
        maxStale <= ttlMin + 120,
        `${healthRow}.maxStaleMin (${maxStale}) exceeds ${ttlVar} (${ttlMin}min) + 120 grace: ` +
          `between minute ${ttlMin} and ${maxStale} the data key is gone while health still reads OK.`,
      );
    });
  }
});

describe('the regional snapshot uses the same daily bound as health', () => {
  const PAIRS = [
    { key: 'economic:macro-signals:v1', healthRow: 'macroSignals' },
    { key: 'economic:stress-index:v1', healthRow: 'economicStress' },
  ];

  for (const { key, healthRow } of PAIRS) {
    it(`${key} matches ${healthRow}.maxStaleMin`, () => {
      assert.equal(
        extractMaxAgeMin(key),
        extractMaxStaleMin(healthRow),
        `${key} would be marked stale on a different schedule than health uses, dragging ` +
          'snapshot_confidence down while the seeder is healthy.',
      );
    });
  }
});

describe('macroSignals is a scheduled producer, not an on-demand key', () => {
  it('is absent from ON_DEMAND_KEYS', () => {
    const m = healthSrc.match(/const ON_DEMAND_KEYS = new Set\(\[(.*?)\]\)/s);
    assert.ok(m, 'could not find ON_DEMAND_KEYS in api/health.js');
    const body = m[1].replace(/\/\/[^\n]*/g, '');
    assert.ok(
      !/'macroSignals'/.test(body),
      'macroSignals is written only by scripts/seed-economy.mjs and read only by ' +
        'server/worldmonitor/economic/v1/get-macro-signals.ts. Nothing populates it after a ' +
        'user action, so ON_DEMAND would soften a scheduled producer outage to EMPTY_ON_DEMAND ' +
        'and subtract it from the warn count — the marketImplications failure again.',
    );
  });
});
