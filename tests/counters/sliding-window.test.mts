import { describe, it, expect } from 'vitest';
import { slidingWindowDecide } from '../../worker/counters/sliding-window';
import { durationToSeconds } from '../../worker/counters/duration';

describe('slidingWindowDecide', () => {
  const WINDOW = 60_000;

  it('allows a request when both windows are empty', () => {
    const d = slidingWindowDecide(
      { currentCount: 0, previousCount: 0, windowStart: 0 },
      0, 600, WINDOW,
    );
    expect(d.success).toBe(true);
    expect(d.limit).toBe(600);
  });

  it('weights the previous window by the fraction of it still in view', () => {
    // Half-way through the current window, half of the previous window still counts.
    const d = slidingWindowDecide(
      { currentCount: 100, previousCount: 200, windowStart: 60_000 },
      90_000, 600, WINDOW,
    );
    // 100 + 200 * 0.5 = 200
    expect(d.observedCount).toBe(200);
    expect(d.success).toBe(true);
  });

  it('rejects exactly at the limit, matching Upstash', () => {
    const d = slidingWindowDecide(
      { currentCount: 600, previousCount: 0, windowStart: 0 },
      0, 600, WINDOW,
    );
    expect(d.success).toBe(false);
  });

  it('ignores a previous window that has scrolled fully out of view', () => {
    const d = slidingWindowDecide(
      { currentCount: 1, previousCount: 10_000, windowStart: 120_000 },
      180_000, 600, WINDOW,
    );
    expect(d.observedCount).toBe(1);
    expect(d.success).toBe(true);
  });

  it('reports reset as the end of the current window', () => {
    const d = slidingWindowDecide(
      { currentCount: 1, previousCount: 0, windowStart: 60_000 },
      70_000, 600, WINDOW,
    );
    expect(d.reset).toBe(120_000);
  });

  // Upstash's slidingWindowLimitScript floors the previous window's weighted
  // contribution before adding it to the current count:
  //   requestsInPreviousWindow = math.floor(( 1 - percentageInCurrent ) * requestsInPreviousWindow)
  // (node_modules/@upstash/ratelimit/dist/index.mjs, singleRegion slidingWindowLimitScript).
  // The brief's reference implementation left this fractional. Pinning the
  // floored value here so a later change can't silently drop the floor.
  it('floors the previous window contribution before summing, matching the Lua script', () => {
    const d = slidingWindowDecide(
      { currentCount: 0, previousCount: 7, windowStart: 0 },
      30_000, 600, WINDOW,
    );
    // 7 * 0.5 = 3.5, floored to 3 per Upstash's math.floor(...) — not 3.5.
    expect(d.observedCount).toBe(3);
  });

  // Upstash derives its weight from `now % window`, which by construction
  // is always in [0, window) — its weight can never exceed 1. This function
  // takes a caller-supplied `windowStart` instead, so a stale/future-dated
  // state (clock skew, out-of-order write) can make `now < windowStart`,
  // driving elapsed negative. Without clamping the high end too, the
  // previous window's weight would exceed 1 and over-count it — a decision
  // Upstash's real algorithm could never produce.
  it('clamps the weight at 1 when now is before windowStart, never counting the previous window more than fully', () => {
    const d = slidingWindowDecide(
      { currentCount: 0, previousCount: 1000, windowStart: 120_000 },
      100_000, 1200, WINDOW,
    );
    // Weight must clamp to 1 (full previous count), not 1.333.
    // observedCount = 0 + 1000 = 1000 < 1200 -> allowed, matching the
    // legitimate weight-1 case, not the erroneous 1333 -> rejected.
    expect(d.observedCount).toBe(1000);
    expect(d.success).toBe(true);
  });
});

// durationToSeconds moved here unchanged from api/_rate-limit-fallback.js
// (task 4, #cf-ratelimit-do) — Task 7 deletes that file once every Upstash
// call site is gone. These pin the exact values the two real policy tables
// in server/_shared/rate-limit.ts depend on, so a rounding-mode regression
// (ceil vs floor) during that move would fail loudly here first.
describe('durationToSeconds', () => {
  it('parses whole-unit windows used by the real policy tables', () => {
    expect(durationToSeconds('60 s')).toBe(60);
    expect(durationToSeconds('1 h')).toBe(3600);
  });

  it('parses a unit with no space, matching the regex without a separator', () => {
    expect(durationToSeconds('30s')).toBe(30);
  });

  it('rounds a sub-second remainder UP (ceil), matching the source it moved from', () => {
    // 500ms = 0.5s; Math.ceil(0.5) = 1, not Math.floor(0.5) = 0. A floor here
    // would let a sub-second window collapse to 0s, which durationToSeconds's
    // own Math.max(1, ...) floor exists specifically to prevent.
    expect(durationToSeconds('500ms')).toBe(1);
  });

  it('never returns less than 1 second, even for a near-zero window', () => {
    expect(durationToSeconds('1ms')).toBe(1);
  });

  it('throws on an unparseable window string', () => {
    expect(() => durationToSeconds('bogus')).toThrow(/Unable to parse rate-limit window/);
  });
});
