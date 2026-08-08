/**
 * Tests for `reserveQuota`'s Durable Object mapping layer in
 * `api/mcp/quota.ts` (task 5, #cf-ratelimit-do, fix round 2).
 *
 * `tests/counters/counter-do.test.mts` proves the wire (protocol.ts) and the
 * DO's own ceiling math via `callCounter` directly. It never exercises
 * `reserveQuota`/`reserveQuotaViaCounter` itself, so this file closes that
 * gap: it injects a fake `CounterStub` (same duck-typed `fetch` shape
 * `callCounter` expects) straight into the production `reserveQuota` seam
 * and asserts on ITS output — the cap-rejection branch, the literal
 * `'cap-exceeded'` / `'redis-unavailable'` reason strings, and the rollback
 * wiring. No production code changed to make this possible: `reserveQuota`
 * already accepts an optional `counterStub` parameter for exactly this. It
 * sits AFTER `planDailyLimit`, hence the `undefined` third argument below —
 * these tests exercise the default 50/day cap.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { reserveQuota } from '../api/mcp/quota.ts';

// A pipeline that throws if called at all — every test here injects a
// counterStub, so reserveQuota must never fall through to the Redis leg.
// If it ever did, this would fail loudly instead of silently double-metering.
const REDIS_LEG_MUST_NOT_RUN = async () => {
  throw new Error('reserveQuota reached the Redis leg despite an injected counterStub');
};

/**
 * Fake Durable Object stub. Answers `daily` with a scripted response (one
 * per call, repeating the last entry if more calls arrive than scripted) and
 * counts `daily-rollback` calls so idempotence can be asserted.
 */
function makeFakeCounterStub(dailyResponses) {
  let dailyCallCount = 0;
  let rollbackCallCount = 0;
  const stub = {
    async fetch(request) {
      const body = await request.json();
      if (body.op === 'daily') {
        const scripted = dailyResponses[Math.min(dailyCallCount, dailyResponses.length - 1)];
        dailyCallCount++;
        return new Response(JSON.stringify({ op: 'daily', ...scripted }));
      }
      if (body.op === 'daily-rollback') {
        rollbackCallCount++;
        return new Response(JSON.stringify({ op: 'daily-rollback', ok: true }));
      }
      throw new Error(`fake counter stub got unexpected op: ${body.op}`);
    },
  };
  return {
    stub,
    rollbackCallCount: () => rollbackCallCount,
    dailyCallCount: () => dailyCallCount,
  };
}

describe('reserveQuota — Durable Object mapping layer (api/mcp/quota.ts)', () => {
  it('under the cap: returns { ok: true } with the expected newCount and a callable rollback', async () => {
    const { stub, rollbackCallCount } = makeFakeCounterStub([
      { allowed: true, metered: true, count: 10, overCeiling: false },
    ]);

    const result = await reserveQuota('pro-user', REDIS_LEG_MUST_NOT_RUN, undefined, stub);

    assert.equal(result.ok, true);
    assert.equal(result.newCount, 10);
    assert.equal(typeof result.rollback, 'function');
    // Production never called rollback on the success path — confirm the
    // DO wasn't touched a second time just by returning this result.
    assert.equal(rollbackCallCount(), 0);
  });

  it('at the boundary: request 51 (overCeiling) returns { ok: false, reason: "cap-exceeded" }', async () => {
    const { stub, rollbackCallCount } = makeFakeCounterStub([
      { allowed: true, metered: true, count: 51, overCeiling: true },
    ]);

    const result = await reserveQuota('pro-user', REDIS_LEG_MUST_NOT_RUN, undefined, stub);

    assert.equal(result.ok, false);
    // Literal string, not a constant — this must catch a future rename of
    // the reason string, which a comparison against an imported constant
    // could not.
    assert.equal(result.reason, 'cap-exceeded');
    // reserveQuotaViaCounter rolls back immediately on overCeiling.
    assert.equal(rollbackCallCount(), 1);
  });

  it('counter unavailable: returns { ok: false, reason: "redis-unavailable" }', async () => {
    const { stub } = makeFakeCounterStub([
      {
        allowed: false,
        metered: false,
        count: 0,
        overCeiling: false,
        reason: 'storage-unavailable',
      },
    ]);

    const result = await reserveQuota('pro-user', REDIS_LEG_MUST_NOT_RUN, undefined, stub);

    assert.equal(result.ok, false);
    // Literal string: the caller's contract (api/mcp/dispatch.ts:143) still
    // speaks 'redis-unavailable' even though a Durable Object, not Redis,
    // is the backend that failed here.
    assert.equal(result.reason, 'redis-unavailable');
  });

  it('rollback is idempotent through the quota.ts layer: calling it twice decrements once', async () => {
    const { stub, rollbackCallCount } = makeFakeCounterStub([
      { allowed: true, metered: true, count: 10, overCeiling: false },
    ]);

    const result = await reserveQuota('pro-user', REDIS_LEG_MUST_NOT_RUN, undefined, stub);
    assert.equal(result.ok, true);

    await result.rollback();
    await result.rollback();

    assert.equal(rollbackCallCount(), 1);
  });
});
