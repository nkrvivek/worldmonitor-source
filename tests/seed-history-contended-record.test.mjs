/**
 * Measured 2026-08-19. `intel-history:energy:intelligence` sat at 47
 * consecutive HTTP 401s with `lastSuccessAt: null` for 11.8 days. Its two
 * sibling resources on the same relay read `consecutiveFailures: 0` with a
 * recent success, and both were failing exactly as hard: they run on Railway
 * AND in the Cloudflare seeds container, both fold into one health key, and
 * the Railway success reset the streak the container was building on every
 * tick. energy:intelligence has no second runtime, so it was the only record
 * of the three that could tell the truth.
 *
 * `consecutiveFailures` answers "is it broken right now" and resets on any
 * success, which is correct for one caller and blind with two. These tests pin
 * the window that remembers failures across successes, and pin that it does
 * NOT fire on the ordinary blip-then-recovery the streak counter already
 * forgives.
 *
 * Run: ./node_modules/.bin/tsx --test tests/seed-history-contended-record.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeHistoryAppendOutcome,
  projectHistoryIngestHealth,
  HISTORY_INGEST_FLAP_WINDOW,
} from '../scripts/_seed-history.mjs';

const AT = Date.UTC(2026, 7, 19, 12, 0, 0);
const MINUTE = 60_000;
const SUCCESS = { inserted: 7, skipped: 3, chunks: 1, abandoned: 0, failedChunks: 0 };

function rejection(status = 401) {
  const err = new Error(`intel-history relay returned HTTP ${status}: {"error":"UNAUTHORIZED"}`);
  err.name = 'SeedHistoryError';
  err.status = status;
  return err;
}

function step(previous, ok, at) {
  const outcome = ok
    ? describeHistoryAppendOutcome(SUCCESS, null)
    : describeHistoryAppendOutcome(null, rejection(401));
  return projectHistoryIngestHealth(previous, {
    domain: 'conflict',
    resource: 'acled-intel',
    runId: 'run-1',
    at,
    outcome,
  });
}

/** Replay a run of ticks, newest last. `h` = success, `f` = 401. */
function replay(pattern) {
  let projected = null;
  pattern.split('').forEach((c, i) => {
    projected = step(projected?.record ?? null, c === 'h', AT + i * MINUTE);
  });
  return projected;
}

describe('a health key two runtimes both write to', () => {
  it('reads degraded when a failing caller alternates with a succeeding one', () => {
    const { record, meta } = replay('hfhfhf');

    assert.equal(record.consecutiveFailures, 1, 'the streak never gets to alarm');
    assert.equal(meta.sourceState, 'degraded');
    assert.equal(meta.flapping, true);
    assert.equal(record.lastErrorCode, 'http_401');
  });

  it('still reads degraded when the succeeding caller writes last', () => {
    const { record, meta } = replay('fhfh');

    assert.equal(record.consecutiveFailures, 0, 'a success resets the streak to zero');
    assert.equal(record.lastSuccessAt, AT + 3 * MINUTE, 'and it looks freshly healthy');
    assert.equal(meta.sourceState, 'degraded', 'but the window still holds two outages');
  });

  it('leaves one blip that recovered alone', () => {
    const { meta } = replay('hhffh');

    assert.equal(meta.sourceState, 'ok');
    assert.equal(meta.flapping, undefined, 'absent, not false, on a clean window');
  });

  it('says nothing new about a record that has only ever failed', () => {
    const { record, meta } = replay('ffff');

    assert.equal(meta.sourceState, 'degraded');
    assert.equal(record.consecutiveFailures, 4, 'the streak already reports this');
    assert.equal(meta.flapping, undefined, 'a streak is not a flap');
  });

  it('forgets an old outage once the window has rolled past it', () => {
    const rolled = replay('ff' + 'h'.repeat(HISTORY_INGEST_FLAP_WINDOW + 2));

    assert.equal(rolled.record.recentAttempts, 'h'.repeat(HISTORY_INGEST_FLAP_WINDOW));
    assert.equal(rolled.meta.sourceState, 'ok');
  });

  it('drops a hand-edited attempt string instead of trusting it', () => {
    const { record } = step({ recentAttempts: 'not-a-window' }, false, AT);

    assert.equal(record.recentAttempts, 'f', 'unreadable history is dropped, never parsed loosely');
  });
});
