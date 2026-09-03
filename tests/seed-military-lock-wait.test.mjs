import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { acquireLockOrWait } from '../scripts/_seed-utils.mjs';

// Regression guard for the 2026-08-25 theaterPosture gap: seed-military-flights
// hit lock contention on two consecutive hourly runs (19:41Z, 20:41Z), printed
// "SKIPPED: another seed run in progress" and exited 0 both times. The seed key
// went unwritten for 165 minutes and nothing was red until the freshness
// monitor tripped hours later. A lock-skip that reads as success is a silent
// coverage gap; the fix is to wait out the holder's TTL once, retry, and fail
// loud if the lock is still held.

const __dir = dirname(fileURLToPath(import.meta.url));
const seederSrc = readFileSync(join(__dir, '../scripts/seed-military-flights.mjs'), 'utf8');

function makeAcquire(results) {
  const calls = [];
  return {
    calls,
    fn: async (domain, runId, ttlMs) => {
      calls.push({ domain, runId, ttlMs });
      return results.shift();
    },
  };
}

describe('acquireLockOrWait', () => {
  it('returns immediately when the first attempt locks — no wait', async () => {
    const acquire = makeAcquire([{ locked: true, skipped: false, reason: null }]);
    let slept = 0;
    const res = await acquireLockOrWait('military:flights', 'r1', 120_000, {
      _acquire: acquire.fn,
      _sleep: async (ms) => { slept += ms; },
    });
    assert.equal(res.locked, true);
    assert.equal(res.waited, false);
    assert.equal(slept, 0);
    assert.equal(acquire.calls.length, 1);
  });

  it('returns the redis-unavailable skip without waiting — a dead Redis is not contention', async () => {
    const acquire = makeAcquire([{ locked: false, skipped: true, reason: 'redis_unavailable' }]);
    let slept = 0;
    const res = await acquireLockOrWait('military:flights', 'r1', 120_000, {
      _acquire: acquire.fn,
      _sleep: async (ms) => { slept += ms; },
    });
    assert.equal(res.skipped, true);
    assert.equal(res.waited, false);
    assert.equal(slept, 0);
  });

  it('on contention: waits past the holder TTL, retries, and returns the second result', async () => {
    const acquire = makeAcquire([
      { locked: false, skipped: false, reason: null },
      { locked: true, skipped: false, reason: null },
    ]);
    let slept = 0;
    const res = await acquireLockOrWait('military:flights', 'r1', 120_000, {
      _acquire: acquire.fn,
      _sleep: async (ms) => { slept += ms; },
    });
    assert.equal(res.locked, true);
    assert.equal(res.waited, true);
    assert.ok(slept >= 120_000, `must sleep past the 120s lock TTL, slept ${slept}ms`);
    assert.equal(acquire.calls.length, 2);
  });

  it('still contended after the wait: reports locked=false so the caller can fail loud', async () => {
    const acquire = makeAcquire([
      { locked: false, skipped: false, reason: null },
      { locked: false, skipped: false, reason: null },
    ]);
    const res = await acquireLockOrWait('military:flights', 'r1', 120_000, {
      _acquire: acquire.fn,
      _sleep: async () => {},
    });
    assert.equal(res.locked, false);
    assert.equal(res.skipped, false);
    assert.equal(res.waited, true);
  });
});

describe('seed-military-flights lock wiring (source invariants)', () => {
  it('both lock sites use acquireLockOrWait, not bare acquireLockSafely', () => {
    const bare = seederSrc.match(/acquireLockSafely\(/g) || [];
    assert.equal(bare.length, 0, 'seeder must not green-exit on first contention');
    const waiting = seederSrc.match(/acquireLockOrWait\(/g) || [];
    assert.ok(waiting.length >= 2, 'both military:flights and theater-posture locks must wait out contention');
  });

  it('persistent contention exits nonzero — a skipped tick must be red, not green', () => {
    assert.ok(
      /process\.exit\(1\)|process\.exitCode = 1/.test(seederSrc),
      'a lock still held after the TTL wait must fail the run so the gap is visible in Actions',
    );
  });
});
