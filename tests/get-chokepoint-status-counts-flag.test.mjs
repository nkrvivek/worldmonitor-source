/**
 * The reader half of the transit-counts fix.
 *
 * `transitSummary.dataAvailable` answers for PortWatch and nothing else, so
 * through the AISStream outage of 2026-08-07 it read true on all thirteen rows
 * while every `todayTotal` was 0 and Hormuz still carried PortWatch's real
 * +58.8 beside its zero. `transitCountsAvailable` is the relay's own flag,
 * written by scripts/seed-transit-summaries.mjs and guarded there by
 * seed-transit-summaries-relay-guard.test.mjs.
 *
 * What that guard cannot see is what this handler does when the flag is not in
 * the payload — a writer rolled back, a key written by an older seed, a rename.
 * The default is the whole fail-safe: absent must read as withheld, the
 * opposite of `dataAvailable`, because a count nobody vouches for is the thing
 * the consumer reports. Nothing tested it until now.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

const TRANSIT_SUMMARIES_KEY = 'supply_chain:transit-summaries:v1';

const CHOKEPOINT_IDS = [
  'suez', 'malacca_strait', 'hormuz_strait', 'bab_el_mandeb', 'panama',
  'taiwan_strait', 'cape_of_good_hope', 'gibraltar', 'bosphorus',
  'korea_strait', 'dover_strait', 'kerch_strait', 'lombok_strait',
];

/** A row as the seed writes it, minus whatever the caller wants left out. */
function summary(overrides = {}) {
  return {
    todayTotal: 41, todayTanker: 12, todayCargo: 25, todayOther: 4,
    wowChangePct: 58.8, history: [],
    riskLevel: 'low', incidentCount7d: 0, disruptionPct: 0,
    riskSummary: '', riskReportAction: '',
    dataAvailable: true,
    transitCountsAvailable: true,
    ...overrides,
  };
}

/**
 * Every id carries a row unless `omit` names it. A row missing from the
 * payload drops the response below full coverage, which is a different signal
 * from the one under test — so the default is a full house.
 */
function payload({ overridesById = {}, omit = [] } = {}) {
  const summaries = {};
  for (const id of CHOKEPOINT_IDS) {
    if (omit.includes(id)) continue;
    summaries[id] = summary(overridesById[id]);
  }
  // Stored shape, verbatim: the canonical keys are envelopes.
  return { _seed: { fetchedAt: Date.now(), recordCount: Object.keys(summaries).length }, data: { summaries } };
}

/**
 * Answers Upstash REST for the transit-summaries key and reports a miss for
 * every other key, so the outer response cache never short-circuits the
 * handler. Anything that is not Upstash is refused — the two other inputs
 * (navigational warnings, vessel snapshot) catch their own failures and the
 * handler treats them as empty.
 */
function serve(stored) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://fake-upstash.example')) {
      throw new Error(`refused: ${url}`);
    }
    if ((init?.method ?? 'GET') === 'POST') {
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    }
    const key = decodeURIComponent(/\/get\/(.+)$/.exec(url)?.[1] ?? '');
    const hit = key.endsWith(TRANSIT_SUMMARIES_KEY) ? JSON.stringify(stored) : null;
    return { ok: true, status: 200, json: async () => ({ result: hit }) };
  };
}

function ctx() {
  return {
    request: new Request('https://worldmonitor.app/api/supply-chain/v1/get-chokepoint-status'),
    pathParams: {},
    headers: {},
  };
}

describe('an absent transitCountsAvailable reads as withheld', () => {
  let getChokepointStatus;

  before(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    ({ getChokepointStatus } = await import('../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts'));
  });

  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    Object.keys(process.env).forEach((k) => { if (!(k in realEnv)) delete process.env[k]; });
    Object.assign(process.env, realEnv);
  });

  async function rowFor(id, opts) {
    serve(payload(opts));
    const response = await getChokepointStatus(ctx(), {});
    const row = response.chokepoints.find((c) => c.id === id);
    assert.ok(row, `no row for ${id}; got ${response.chokepoints.length} chokepoints`);
    return row;
  }

  // The fail-safe. A payload written before the field existed says nothing
  // about the relay, and silence is not a vouch.
  it('withholds the counts when the writer sent no flag', async () => {
    const row = await rowFor('suez', {
      overridesById: { suez: { transitCountsAvailable: undefined } },
    });

    assert.equal(row.transitSummary.transitCountsAvailable, false);
  });

  // The asymmetry is deliberate and is the reason this file exists: the two
  // flags default opposite ways because they answer for different feeds.
  it('still defaults dataAvailable the other way on that same row', async () => {
    const row = await rowFor('suez', {
      overridesById: { suez: { dataAvailable: undefined, transitCountsAvailable: undefined } },
    });

    assert.equal(row.transitSummary.dataAvailable, true);
    assert.equal(row.transitSummary.transitCountsAvailable, false);
  });

  it('passes a measured false through', async () => {
    const row = await rowFor('hormuz_strait', {
      overridesById: { hormuz_strait: { transitCountsAvailable: false, todayTotal: 0 } },
    });

    assert.equal(row.transitSummary.transitCountsAvailable, false);
    // PortWatch was up throughout the outage and its change is a real reading.
    // The flag is what separates it from the count beside it.
    assert.equal(row.transitSummary.wowChangePct, 58.8);
  });

  it('passes a vouched count through', async () => {
    const row = await rowFor('suez');

    assert.equal(row.transitSummary.transitCountsAvailable, true);
    assert.equal(row.transitSummary.todayTotal, 41);
  });

  // The zero-state row the handler builds for a chokepoint with no summary at
  // all. Its counts are invented, not measured, so they may never read vouched.
  it('withholds the counts on a chokepoint the payload never mentioned', async () => {
    const row = await rowFor('lombok_strait', { omit: ['lombok_strait'] });

    assert.equal(row.transitSummary.transitCountsAvailable, false);
    assert.equal(row.transitSummary.dataAvailable, false);
    assert.equal(row.transitSummary.todayTotal, 0);
  });
});
