import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchFredSeries,
  FRED_SERIES,
  FRED_RETRY_BUDGET_MS,
  FRED_RETRY_MAX_FAILURES,
} from '../scripts/seed-economy.mjs';

// A FRED series that bounces once used to cost a FULL DAY of staleness.
//
// Measured 2026-08-12 against production Redis. Eight of the nine FRED series
// the forecast health check watches carried fetchedAt 2026-08-12T09:00:46Z --
// the daily cron. M2SL alone carried 2026-08-11T23:20:48Z, so /api/health read
// forecastFredM2sl STALE_SEED with seedAgeMin 1527 against maxStaleMin 1500.
//
// Nothing about M2SL is broken: fetchFredSeries pulls all 24 series in under a
// second from this laptop. It bounced once inside the container, where every
// call goes through the proxy. The batch then simply omits it -- a rejected
// series is a console.warn and an absent key -- and the next write is the next
// day's cron.
//
// The arithmetic is what makes one bounce fatal. registry.ts schedules
// seed-economy at '0 9 * * *' = 1440 minutes apart, and the health budget is
// maxStaleMin 1500. That is 60 minutes of headroom, so ONE missed series is
// guaranteed to go STALE_SEED and stay there for ~24 hours.
//
// Do not widen the 1500 -- it is the thing that caught this. Retry the series.
//
// The retry pass is deliberately serial and budget-bounded. The concurrent
// batch already consumes up to ~164s of runSeed's 240s fetch-phase deadline
// (see FRED_CONCURRENCY), and a single fredFetchJson costs up to ~82s with the
// proxy down, so an unbounded retry of 24 series would breach the deadline and
// reproduce the exit-75 crash of #5037 while trying to fix a stale key.

const realLog = console.log;
const realWarn = console.warn;
before(() => { console.log = () => {}; console.warn = () => {}; });
after(() => { console.log = realLog; console.warn = realWarn; });

function seriesIdFromUrl(url) {
  return new URL(url).searchParams.get('series_id');
}
function isObservations(url) {
  return url.includes('/series/observations');
}

// Fails the observations call for `failSeries` on the FIRST attempt only, then
// succeeds -- the transient bounce this fix exists for. Counts observation
// attempts per series so a test can prove a replay actually happened rather
// than inferring it from the result.
// `replayDelayMs` slows ONLY the replay attempts. Delaying the first batch too
// would multiply across 24 series and hang the suite rather than test anything.
function makeFlakyFred({ failSeries = new Set(), failTimes = 1, replayDelayMs = 0 } = {}) {
  const attempts = new Map();
  const fn = async (url) => {
    const seriesId = seriesIdFromUrl(url);
    if (!isObservations(url)) {
      return { seriess: [{ title: `${seriesId} title`, units: 'Percent', frequency: 'Daily' }] };
    }
    const n = (attempts.get(seriesId) ?? 0) + 1;
    attempts.set(seriesId, n);
    if (replayDelayMs && n > 1) await new Promise((r) => setTimeout(r, replayDelayMs));
    if (failSeries.has(seriesId) && n <= failTimes) {
      throw new Error(`simulated FRED bounce for ${seriesId} (attempt ${n})`);
    }
    return { observations: [{ date: '2026-07-01', value: '1.23' }] };
  };
  return { fn, attempts };
}

describe('seed-economy fetchFredSeries — one bounce must not cost a day of staleness', () => {
  before(() => { process.env.FRED_API_KEY = 'test-key'; });

  it('replays a series that failed once, so it lands in the same run', async () => {
    // M2SL is the series this was measured on; index 8 of FRED_SERIES.
    const flaky = makeFlakyFred({ failSeries: new Set(['M2SL']) });
    const results = await fetchFredSeries({ fredFetchFn: flaky.fn });

    assert.ok(
      results.M2SL,
      'M2SL bounced once and was never retried — this is the 1527-minute staleness, reproduced',
    );
    assert.equal(flaky.attempts.get('M2SL'), 2, 'exactly one replay, not a retry storm');
    assert.equal(
      Object.keys(results).length,
      FRED_SERIES.length,
      'every series must be present once the bounced one is replayed',
    );
    // Healthy series must not be re-fetched: the replay pass is for failures only.
    assert.equal(flaky.attempts.get('WALCL'), 1, 'a healthy series must not be re-fetched');
  });

  it('gives up on a series that fails again, and leaves the rest intact', async () => {
    const flaky = makeFlakyFred({ failSeries: new Set(['M2SL']), failTimes: 99 });
    const results = await fetchFredSeries({ fredFetchFn: flaky.fn });

    assert.equal(results.M2SL, undefined, 'a genuinely broken series stays absent — no fabricated write');
    assert.equal(flaky.attempts.get('M2SL'), 2, 'one replay only; a hard failure must not loop');
    assert.equal(Object.keys(results).length, FRED_SERIES.length - 1);
  });

  it('skips the replay pass entirely when the failure is systemic', async () => {
    // Above FRED_RETRY_MAX_FAILURES the proxy is down, not one series flaking.
    // Replaying 24 series serially at up to ~82s each would breach the 240s
    // fetch-phase deadline and re-create the exit-75 crash of #5037.
    const failing = FRED_SERIES.slice(0, FRED_RETRY_MAX_FAILURES + 1);
    const flaky = makeFlakyFred({ failSeries: new Set(failing) });
    const results = await fetchFredSeries({ fredFetchFn: flaky.fn });

    for (const id of failing) {
      assert.equal(results[id], undefined, `${id} must stay absent — a systemic failure is not replayed`);
      assert.equal(flaky.attempts.get(id), 1, `${id} must not be replayed when the whole proxy is down`);
    }
    assert.equal(Object.keys(results).length, FRED_SERIES.length - failing.length);
  });

  it('stops replaying when the retry budget is spent rather than breaching the deadline', async () => {
    // Each replay sleeps past a deliberately tiny budget, so the first replay
    // spends it and the rest are never attempted. What matters is that the pass
    // STOPS, not how many it got through.
    const TINY_BUDGET_MS = 20;
    const failing = FRED_SERIES.slice(0, 3);
    const flaky = makeFlakyFred({
      failSeries: new Set(failing),
      replayDelayMs: TINY_BUDGET_MS * 4,
    });
    const started = Date.now();
    const results = await fetchFredSeries({
      fredFetchFn: flaky.fn,
      retryBudgetMs: TINY_BUDGET_MS,
    });
    const elapsed = Date.now() - started;

    const replayed = failing.filter((id) => flaky.attempts.get(id) > 1);
    assert.ok(
      replayed.length < failing.length,
      `the budget must stop the pass; all ${failing.length} were replayed`,
    );
    assert.ok(elapsed < FRED_RETRY_BUDGET_MS, 'the pass must not run past its own budget');
    assert.ok(Object.keys(results).length >= FRED_SERIES.length - failing.length);
  });

  it('states a retry budget that fits inside what the concurrent batch leaves', () => {
    // runSeed's fetch phase is 240s and the concurrent batch can use ~164s of
    // it (2 waves × ~82s). The replay pass must fit in the remainder with room
    // for the writes that follow, or the fix becomes the next crash.
    assert.ok(FRED_RETRY_BUDGET_MS > 0);
    assert.ok(
      FRED_RETRY_BUDGET_MS <= 240_000 - 164_000,
      `retry budget ${FRED_RETRY_BUDGET_MS}ms does not fit in the ~76s the batch leaves of the 240s fetch phase`,
    );
  });
});
