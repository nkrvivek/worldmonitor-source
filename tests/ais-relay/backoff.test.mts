import { describe, it, expect } from 'vitest';
import { computeBackoffMs, MAX_BACKOFF_ATTEMPT } from '../../worker/ais/backoff';

describe('computeBackoffMs', () => {
  it('never exceeds the cap regardless of attempt number', () => {
    for (const attempt of [0, 1, 5, 10, 20, 50, 1000]) {
      const ms = computeBackoffMs(attempt);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(60_000);
    }
  });

  it('grows roughly exponentially before the cap, staying under 2^attempt * BASE_MS', () => {
    // attempt 0: base is 1000ms, so the ceiling before the outer min() is 1000.
    // attempt 3: base * 2^3 = 8000, still under the 60_000 cap.
    const samples = Array.from({ length: 200 }, () => computeBackoffMs(3));
    expect(Math.max(...samples)).toBeLessThanOrEqual(8_000);
  });

  it('MAX_BACKOFF_ATTEMPT is a finite clamp, not a magic unused export', () => {
    expect(MAX_BACKOFF_ATTEMPT).toBe(20);
  });
});
