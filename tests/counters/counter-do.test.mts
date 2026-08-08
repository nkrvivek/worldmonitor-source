import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { callCounter } from '../../worker/counters/protocol';
import type { CounterDO } from '../../worker/counters/counter-do';

function stubFor(name: string) {
  return env.COUNTER.get(env.COUNTER.idFromName(name));
}

describe('CounterDO sliding window', () => {
  it('allows up to the limit and then rejects', async () => {
    const stub = stubFor('sliding-basic');
    const req = { op: 'sliding', key: 'ip:1.2.3.4', limit: 3, windowMs: 60_000 } as const;

    for (let i = 0; i < 3; i++) {
      const r = await callCounter(stub, req);
      expect(r.op === 'sliding' && r.success).toBe(true);
    }
    const denied = await callCounter(stub, req);
    expect(denied.op === 'sliding' && denied.success).toBe(false);
  });

  it('keeps separate keys independent', async () => {
    const stub = stubFor('sliding-isolation');
    const a = { op: 'sliding', key: 'ip:a', limit: 1, windowMs: 60_000 } as const;
    const b = { op: 'sliding', key: 'ip:b', limit: 1, windowMs: 60_000 } as const;
    await callCounter(stub, a);
    const first = await callCounter(stub, b);
    expect(first.op === 'sliding' && first.success).toBe(true);
  });

  it('pins reset to a window-aligned boundary, not now + windowMs', async () => {
    // slidingWindowDecide (Task 1) trusts its caller to pass a windowStart
    // already aligned to Math.floor(now / windowMs) * windowMs — it does not
    // validate this itself. If the DO ever stopped aligning before calling
    // it, `reset` would silently drift to an arbitrary offset from `now`
    // instead of landing on the next window boundary, and no other test
    // here would catch it because they only assert success/failure.
    const stub = stubFor('sliding-alignment');
    const windowMs = 60_000;
    const before = Date.now();
    const r = await callCounter(stub, { op: 'sliding', key: 'ip:align', limit: 5, windowMs });
    const after = Date.now();
    expect(r.op).toBe('sliding');
    if (r.op !== 'sliding') throw new Error('unreachable');

    // The window boundary nearest `now`, for any instant this test observed.
    const expectedResetLow = Math.floor(before / windowMs) * windowMs + windowMs;
    const expectedResetHigh = Math.floor(after / windowMs) * windowMs + windowMs;
    expect(r.reset === expectedResetLow || r.reset === expectedResetHigh).toBe(true);
    // An aligned reset is always an exact multiple of windowMs; an
    // unaligned `now + windowMs` reset would not be, except by coincidence.
    expect(r.reset % windowMs).toBe(0);
  });
});

describe('CounterDO daily meter', () => {
  it('distinguishes a missing key from a real zero', async () => {
    const stub = stubFor('daily-presence');
    const before = await callCounter(stub, { op: 'daily-read', namespace: 'rl:apikey:day', userId: 'never-seen' });
    expect(before.op === 'daily-read' && before.present).toBe(false);

    await callCounter(stub, {
      op: 'daily', namespace: 'rl:apikey:day', userId: 'u1',
      allowance: 10, ttlSeconds: 172_800, posture: 'allow',
    });
    const after = await callCounter(stub, { op: 'daily-read', namespace: 'rl:apikey:day', userId: 'u1' });
    expect(after.op === 'daily-read' && after.present).toBe(true);
    expect(after.op === 'daily-read' && after.count).toBe(1);
  });

  it('passes a caller-supplied ceilingMultiplier through to reserveDaily', async () => {
    // Deviation from the task-3 brief: MeterOptions grew an optional
    // ceilingMultiplier after the brief was written, so MCP's quota meter
    // (Task 5) can cap at x1 instead of the REST meter's x10. Pin that the
    // DO actually forwards it, not just accepts it on the wire.
    const stub = stubFor('daily-ceiling-x1');
    // allowance 5 x1 ceiling means overCeiling flips as soon as count > 5.
    for (let i = 0; i < 5; i++) {
      const r = await callCounter(stub, {
        op: 'daily', namespace: 'rl:mcp:day', userId: 'u1',
        allowance: 5, ttlSeconds: 172_800, posture: 'deny', ceilingMultiplier: 1,
      });
      expect(r.op === 'daily' && r.overCeiling).toBe(false);
    }
    const sixth = await callCounter(stub, {
      op: 'daily', namespace: 'rl:mcp:day', userId: 'u1',
      allowance: 5, ttlSeconds: 172_800, posture: 'deny', ceilingMultiplier: 1,
    });
    expect(sixth.op === 'daily' && sixth.overCeiling).toBe(true);
  });

  it('ceilingMultiplier actually moves the overCeiling boundary — the field is not dropped on the floor', async () => {
    // Parked minor from Task 3: no test pinned that ceilingMultiplier
    // survives the round trip from protocol.ts's wire type, through
    // CounterDO.daily(), into reserveDaily's own ceiling math. Task 5 (the
    // MCP quota meter) is the call site that makes this load-bearing: if
    // either hop silently dropped the field, quota.ts's `ceilingMultiplier:
    // 1` request would fall back to the meter's x10 default and the
    // production cap would revert from 50/day to 500/day with no visible
    // error anywhere. Same allowance, same request count, only
    // ceilingMultiplier differs — the boundary must move.
    const defaultStub = stubFor('ceiling-boundary-default');
    let defaultResult;
    for (let i = 0; i < 6; i++) {
      defaultResult = await callCounter(defaultStub, {
        op: 'daily', namespace: 'ceiling-boundary-test', userId: 'u1',
        allowance: 5, ttlSeconds: 172_800, posture: 'deny',
      });
    }
    // Default x10 ceiling: 5 * 10 = 50. Count 6 is nowhere near it.
    expect(defaultResult!.op === 'daily' && defaultResult!.overCeiling).toBe(false);

    const x1Stub = stubFor('ceiling-boundary-x1');
    let x1Result;
    for (let i = 0; i < 6; i++) {
      x1Result = await callCounter(x1Stub, {
        op: 'daily', namespace: 'ceiling-boundary-test', userId: 'u1',
        allowance: 5, ttlSeconds: 172_800, posture: 'deny', ceilingMultiplier: 1,
      });
    }
    // x1 ceiling: 5 * 1 = 5. Count 6 is one over.
    expect(x1Result!.op === 'daily' && x1Result!.overCeiling).toBe(true);
  });

  it('rolls back the daily counter', async () => {
    const stub = stubFor('daily-rollback');
    await callCounter(stub, {
      op: 'daily', namespace: 'rl:apikey:day', userId: 'u2',
      allowance: 10, ttlSeconds: 172_800, posture: 'allow',
    });
    await callCounter(stub, { op: 'daily-rollback', namespace: 'rl:apikey:day', userId: 'u2' });
    const after = await callCounter(stub, { op: 'daily-read', namespace: 'rl:apikey:day', userId: 'u2' });
    expect(after.op === 'daily-read' && after.count).toBe(0);
    expect(after.op === 'daily-read' && after.present).toBe(true);
  });
});

describe('MCP quota keeps its hard-cap posture', () => {
  it('rejects rather than dispatching when storage is unavailable', async () => {
    // posture 'deny' is what makes this a hard cap. If this test ever passes
    // with allowed: true, the MCP quota has silently become fail-open and the
    // Pro tier is uncapped. Assert BOTH allowed and metered: metered alone
    // would still pass if allowed silently flipped to true — allowed is the
    // field a caller would actually branch a dispatch decision on.
    const stub = env.COUNTER.get(env.COUNTER.idFromName('mcp-posture'));
    const r = await callCounter(stub, {
      op: 'daily', namespace: 'mcp:pro-usage', userId: '',
      allowance: 50, ttlSeconds: 172_800, posture: 'deny',
    });
    expect(r.op === 'daily' && r.allowed).toBe(false);
    expect(r.op === 'daily' && r.metered).toBe(false);
  });

  it('stops the 51st request of the day', async () => {
    // Mirrors the real call quota.ts::reserveQuotaViaCounter makes:
    // allowance PRO_DAILY_QUOTA_LIMIT (50) with ceilingMultiplier: 1, so the
    // ceiling IS the allowance — no x10 grace band. Request 50 must land at
    // the boundary without tripping it; request 51 must trip it. quota.ts
    // maps `overCeiling: true` here onto `reason: 'cap-exceeded'`.
    const stub = env.COUNTER.get(env.COUNTER.idFromName('mcp-cap'));
    let atFifty;
    for (let i = 0; i < 50; i++) {
      atFifty = await callCounter(stub, {
        op: 'daily', namespace: 'mcp:pro-usage', userId: 'pro-user',
        allowance: 50, ttlSeconds: 172_800, posture: 'deny', ceilingMultiplier: 1,
      });
    }
    expect(atFifty!.op === 'daily' && atFifty!.overCeiling).toBe(false);

    const fiftyFirst = await callCounter(stub, {
      op: 'daily', namespace: 'mcp:pro-usage', userId: 'pro-user',
      allowance: 50, ttlSeconds: 172_800, posture: 'deny', ceilingMultiplier: 1,
    });
    expect(fiftyFirst.op === 'daily' && fiftyFirst.overCeiling).toBe(true);
  });
});

describe('the usage reader cannot mistake missing for zero', () => {
  it('reports present:false for a user with no meter row', async () => {
    const stub = env.COUNTER.get(env.COUNTER.idFromName('usage-missing'));
    const r = await callCounter(stub, {
      op: 'daily-read', namespace: 'rl:apikey:day', userId: 'no-such-user',
    });
    expect(r.op === 'daily-read' && r.present).toBe(false);
    expect(r.op === 'daily-read' && r.count).toBe(0);
  });

  it('reports present:true with a real zero after a rollback', async () => {
    const stub = env.COUNTER.get(env.COUNTER.idFromName('usage-real-zero'));
    await callCounter(stub, {
      op: 'daily', namespace: 'rl:apikey:day', userId: 'u1',
      allowance: 10, ttlSeconds: 172_800, posture: 'allow',
    });
    await callCounter(stub, { op: 'daily-rollback', namespace: 'rl:apikey:day', userId: 'u1' });
    const r = await callCounter(stub, {
      op: 'daily-read', namespace: 'rl:apikey:day', userId: 'u1',
    });
    expect(r.op === 'daily-read' && r.present).toBe(true);
    expect(r.op === 'daily-read' && r.count).toBe(0);
  });
});

describe('CounterDO nonce-check (replay-nonce cache)', () => {
  it('reports a fresh nonce as not seen, and the same nonce again as seen', async () => {
    const stub = stubFor('nonce-fresh');
    const first = await callCounter(stub, {
      op: 'nonce-check', namespace: 'nonce:counter-read', nonce: 'nonce-a', ttlSeconds: 65,
    });
    expect(first.op === 'nonce-check' && first.metered).toBe(true);
    expect(first.op === 'nonce-check' && first.seen).toBe(false);

    const replay = await callCounter(stub, {
      op: 'nonce-check', namespace: 'nonce:counter-read', nonce: 'nonce-a', ttlSeconds: 65,
    });
    expect(replay.op === 'nonce-check' && replay.metered).toBe(true);
    expect(replay.op === 'nonce-check' && replay.seen).toBe(true);
  });

  it('keeps distinct nonces independent of each other', async () => {
    const stub = stubFor('nonce-isolation');
    await callCounter(stub, {
      op: 'nonce-check', namespace: 'nonce:counter-read', nonce: 'nonce-b', ttlSeconds: 65,
    });
    const other = await callCounter(stub, {
      op: 'nonce-check', namespace: 'nonce:counter-read', nonce: 'nonce-c', ttlSeconds: 65,
    });
    expect(other.op === 'nonce-check' && other.seen).toBe(false);
  });

  it('does not fold a calendar day into the storage key -- the whole point of this op', async () => {
    // This is the direct fix for the reviewed defect: 'daily' partitions its
    // key by dailyKey()'s UTC calendar day, so a replay landing on the other
    // side of a UTC-midnight boundary would compute a different key and slip
    // past the guard. 'nonce-check' must answer the same way regardless of
    // what day it is -- there is no `now`/`Date` parameter on this op's wire
    // shape at all (protocol.ts), unlike 'daily', which takes none either but
    // gets its date from the DO's own `new Date()` at dispatch time. Two
    // separate DO instances, same nonce value, both starting fresh: neither
    // should see the other's write (different shards), but repeating the
    // SAME nonce against the SAME shard must always be caught, which is what
    // the two tests above already pin. This test instead pins that
    // `nonce-check`'s response shape carries nothing date-shaped for a
    // caller to (mis)use -- `seen`/`metered` only.
    const stub = stubFor('nonce-shape');
    const r = await callCounter(stub, {
      op: 'nonce-check', namespace: 'nonce:counter-read', nonce: 'nonce-d', ttlSeconds: 65,
    });
    expect(r.op).toBe('nonce-check');
    if (r.op !== 'nonce-check') throw new Error('unreachable');
    expect(Object.keys(r).sort()).toEqual(['metered', 'op', 'seen'].sort());
  });
});

describe('CounterDO compare-and-delete', () => {
  it('deletes only when the stored value matches', async () => {
    const stub = stubFor('cad');
    // The explicit <CounterDO, void> matters, not just style: leaving O to be
    // inferred from `stub` makes tsc expand DurableObjectStub<CounterDO>'s
    // full RPC surface (Rpc.Provider<CounterDO, ...>) to reverse-derive O,
    // which recurses through Cloudflare's own ambient types and fails with
    // "TS2589: Type instantiation is excessively deep and possibly infinite".
    // Naming O up front turns that into a plain assignability check instead
    // of an inference problem, and the error disappears. callCounter() never
    // hit this because its param type is a plain `{ fetch(...): ... }`
    // structural interface, so it never forces that expansion.
    await runInDurableObject<CounterDO, void>(stub, async (instance) => {
      await instance.setForTest('lock:x', 'token-a');
    });

    const wrong = await callCounter(stub, { op: 'compare-delete', key: 'lock:x', expected: 'token-b' });
    expect(wrong.op === 'compare-delete' && wrong.deleted).toBe(false);

    const right = await callCounter(stub, { op: 'compare-delete', key: 'lock:x', expected: 'token-a' });
    expect(right.op === 'compare-delete' && right.deleted).toBe(true);
  });
});
