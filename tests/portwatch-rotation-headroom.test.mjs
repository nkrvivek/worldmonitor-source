import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessRotationHeadroom } from '../scripts/seed-portwatch-port-activity.mjs';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_CACHE_AGE = 7 * DAY;

// The run this reconstructs: measured 2026-08-19, after the 12h cron had not
// fired for ~5.7 days. 113 countries were served on cache written 6.72 days
// earlier, the queue could clear 30 per run, and the health row still read a
// comfortable 173/174. Nothing anywhere said that ~113 of them were hours from
// dropping out at once.
function staleFleet(count, ageMs, now) {
  return Array.from({ length: count }, (_, i) => ({
    iso2: `C${String(i).padStart(3, '0')}`,
    cacheWrittenAt: now - ageMs,
  }));
}

describe('portwatch rotation headroom', () => {
  it('names the countries that expire before the queue reaches them', () => {
    const now = 1_787_000_000_000;
    const result = assessRotationHeadroom({
      staleServed: staleFleet(113, 6.72 * DAY, now),
      backlogCount: 113,
      maxPerRun: 30,
      now,
    });

    // 113 countries at 30 a run is 4 runs, so 48 hours before the last slot.
    assert.equal(result.runsToDrain, 4);
    assert.equal(result.horizonMs, 48 * HOUR);
    // Each has about 6.7 hours of cache left. Every one of them is at risk.
    assert.equal(result.atRiskCount, 113);
  });

  it('stays quiet when the sweep fits inside the cache life', () => {
    const now = 1_787_000_000_000;
    const result = assessRotationHeadroom({
      staleServed: staleFleet(60, 1 * DAY, now),
      backlogCount: 60,
      maxPerRun: 30,
      now,
    });

    assert.equal(result.runsToDrain, 2);
    assert.equal(result.atRiskCount, 0);
  });

  it('counts a cache with no readable clock as at risk, never as fresh', () => {
    // Absent is not zero and not full. An unreadable cacheWrittenAt means the
    // remaining life is unknown; reading it as fresh is the silent version of
    // this same failure.
    const now = 1_787_000_000_000;
    const result = assessRotationHeadroom({
      staleServed: [
        { iso2: 'AA', cacheWrittenAt: now - 1 * DAY },
        { iso2: 'BB', cacheWrittenAt: undefined },
        { iso2: 'CC', cacheWrittenAt: Number.NaN },
      ],
      backlogCount: 3,
      maxPerRun: 30,
      now,
    });

    assert.equal(result.runsToDrain, 1);
    assert.deepEqual(result.atRisk.map(r => r.iso2), ['BB', 'CC']);
  });

  it('reports the soonest expiry first so the log names the real deadline', () => {
    const now = 1_787_000_000_000;
    const result = assessRotationHeadroom({
      staleServed: [
        { iso2: 'LATE', cacheWrittenAt: now - (7 * DAY - 40 * HOUR) },
        { iso2: 'SOON', cacheWrittenAt: now - (7 * DAY - 2 * HOUR) },
        { iso2: 'MID', cacheWrittenAt: now - (7 * DAY - 20 * HOUR) },
      ],
      backlogCount: 90,
      maxPerRun: 30,
      now,
    });

    assert.equal(result.runsToDrain, 3);
    assert.deepEqual(result.atRisk.map(r => r.iso2), ['SOON', 'MID']);
    // LATE has 40h of life against a 36h horizon, so it is not reported.
    assert.equal(result.atRiskCount, 2);
  });

  it('an empty backlog cannot put anything at risk', () => {
    const now = 1_787_000_000_000;
    const result = assessRotationHeadroom({ staleServed: [], backlogCount: 0, now });
    assert.equal(result.runsToDrain, 0);
    assert.equal(result.atRiskCount, 0);
  });

  it('defaults match the schedule the rotation comment assumes', () => {
    // 12h cron, 30 per run, 7-day cache life. If any of these three move, the
    // arithmetic in the comment above MAX_COLD_FETCH_PER_RUN moves with it.
    const now = 1_787_000_000_000;
    const result = assessRotationHeadroom({
      staleServed: [{ iso2: 'ZZ', cacheWrittenAt: now - (MAX_CACHE_AGE - HOUR) }],
      backlogCount: 174,
      now,
    });
    assert.equal(result.runsToDrain, 6);
    assert.equal(result.horizonMs, 72 * HOUR);
    assert.equal(result.atRiskCount, 1);
  });
});
