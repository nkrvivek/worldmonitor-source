import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CACHE_TTL } from '../server/worldmonitor/infrastructure/v1/get-cable-health';
// @ts-expect-error - api/health.js is plain JS with no declaration file
import { __testing__ as healthTesting } from '../api/health.js';

const { SEED_META, MISSING_DATA_IS_FAILURE_KEYS, EMPTY_DATA_OK_KEYS } = healthTesting as {
  SEED_META: Record<string, { key: string; maxStaleMin: number }>;
  MISSING_DATA_IS_FAILURE_KEYS: Set<string>;
  EMPTY_DATA_OK_KEYS: Set<string>;
};

// Two halves that have to agree and live in different languages in different
// directories, so nothing but a test holds them together.
//
// get-cable-health.ts decides how long `cable-health-v1` exists. api/health.js
// decides how long it goes on vouching for the reading that key holds, from a
// seed-meta entry written with a 7-day TTL. cableHealth is in
// MISSING_DATA_IS_FAILURE_KEYS, so a fresh meta beside a missing data key is
// reported as EMPTY — a real alarm, and the correct one when a publish fails.
//
// It is not correct when the data key simply expired first. That is the pair
// contradicting itself, and it fires on a healthy endpoint: measured
// 2026-08-14, `cableHealth: status=EMPTY records=0 age=35m max=90m` failed the
// Seed Freshness Monitor while NGA was up, and a single authenticated warm
// flipped health to OK within seconds. The TTL was 1800 against a 90-minute
// bound, so any warm gap between 30 and 90 minutes produced it by construction.
describe('cable-health cache TTL against the health freshness bound', () => {
  it('keeps the data key alive for longer than health.js vouches for it', () => {
    const boundSeconds = SEED_META.cableHealth.maxStaleMin * 60;

    assert.ok(
      CACHE_TTL > boundSeconds,
      `cable-health-v1 lives ${CACHE_TTL}s but api/health.js calls its seed-meta fresh for ` +
        `${boundSeconds}s (maxStaleMin ${SEED_META.cableHealth.maxStaleMin}). Every warm gap ` +
        `between the two reports EMPTY on a healthy endpoint. Raise CACHE_TTL in ` +
        `server/worldmonitor/infrastructure/v1/get-cable-health.ts, or lower maxStaleMin.`,
    );
  });

  it('still guards the pair that makes the ordering matter', () => {
    // If cableHealth ever leaves MISSING_DATA_IS_FAILURE_KEYS, the test above is
    // guarding an ordering nothing reads any more and should be deleted rather
    // than left to pass for the wrong reason.
    assert.ok(
      MISSING_DATA_IS_FAILURE_KEYS.has('cableHealth'),
      'cableHealth no longer treats a missing data key as a failure, so the TTL ordering above ' +
        'protects nothing — re-read this test before keeping it.',
    );
    // An empty cable map is the ordinary calm-sea reading: computeHealthMap
    // emits an entry only for a cable carrying a live signal. The EMPTY this
    // fixes is about the key being ABSENT, never about it holding zero cables,
    // and that distinction is what EMPTY_DATA_OK_KEYS records.
    assert.ok(
      EMPTY_DATA_OK_KEYS.has('cableHealth'),
      'a computed map with no disrupted cables is a healthy sea, not an empty publish',
    );
  });
});
