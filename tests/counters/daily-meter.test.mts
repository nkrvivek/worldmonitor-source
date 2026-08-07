import { describe, it, expect } from 'vitest';
import { reserveDaily, dailyKey, type MeterStore } from '../../worker/counters/daily-meter';

function fakeStore(initial = 0, failOn: 'none' | 'increment' = 'none'): MeterStore & { value: number } {
  return {
    value: initial,
    async increment(_key: string, _ttlSeconds: number) {
      if (failOn === 'increment') throw new Error('storage down');
      this.value += 1;
      return this.value;
    },
    async decrement(_key: string) {
      this.value -= 1;
    },
  };
}

describe('dailyKey', () => {
  it('uses the UTC calendar day, zero-padded', () => {
    expect(dailyKey('rl:apikey:day', 'u1', new Date('2026-03-07T23:59:59Z')))
      .toBe('rl:apikey:day:u1:2026-03-07');
  });

  it('does not roll over on a local-time boundary', () => {
    // 2026-03-08T00:30Z is still the 8th in UTC regardless of the runner's zone.
    expect(dailyKey('rl:apikey:day', 'u1', new Date('2026-03-08T00:30:00Z')))
      .toBe('rl:apikey:day:u1:2026-03-08');
  });
});

describe('reserveDaily', () => {
  it('counts a request and reports the new count', async () => {
    const store = fakeStore(0);
    const r = await reserveDaily(store, {
      namespace: 'rl:apikey:day', userId: 'u1', allowance: 10,
      ttlSeconds: 172_800, onStorageFailure: 'allow', now: new Date('2026-03-07T00:00:00Z'),
    });
    expect(r.metered).toBe(true);
    expect(r.count).toBe(1);
    expect(r.overCeiling).toBe(false);
  });

  it('flags overCeiling only above allowance times the ceiling multiplier', async () => {
    const store = fakeStore(100);
    const r = await reserveDaily(store, {
      namespace: 'rl:apikey:day', userId: 'u1', allowance: 10,
      ttlSeconds: 172_800, onStorageFailure: 'allow', now: new Date('2026-03-07T00:00:00Z'),
    });
    // count becomes 101, allowance 10 x 10 = 100, so 101 > 100
    expect(r.overCeiling).toBe(true);
  });

  it('fails OPEN when told to: storage down means uncounted and allowed', async () => {
    const store = fakeStore(0, 'increment');
    const r = await reserveDaily(store, {
      namespace: 'rl:apikey:day', userId: 'u1', allowance: 10,
      ttlSeconds: 172_800, onStorageFailure: 'allow', now: new Date('2026-03-07T00:00:00Z'),
    });
    expect(r.metered).toBe(false);
    expect(r.allowed).toBe(true);
  });

  it('fails CLOSED when told to: storage down means rejected', async () => {
    const store = fakeStore(0, 'increment');
    const r = await reserveDaily(store, {
      namespace: 'mcp:pro-usage', userId: 'u1', allowance: 50,
      ttlSeconds: 172_800, onStorageFailure: 'deny', now: new Date('2026-03-07T00:00:00Z'),
    });
    expect(r.metered).toBe(false);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('storage-unavailable');
  });

  it('rollback decrements once and is idempotent', async () => {
    const store = fakeStore(0);
    const r = await reserveDaily(store, {
      namespace: 'rl:apikey:day', userId: 'u1', allowance: 10,
      ttlSeconds: 172_800, onStorageFailure: 'allow', now: new Date('2026-03-07T00:00:00Z'),
    });
    expect(store.value).toBe(1);
    await r.rollback();
    await r.rollback();
    expect(store.value).toBe(0);
  });

  it('does not touch storage when allowance is zero or less', async () => {
    const store = fakeStore(0);
    const r = await reserveDaily(store, {
      namespace: 'rl:apikey:day', userId: 'u1', allowance: 0,
      ttlSeconds: 172_800, onStorageFailure: 'allow', now: new Date('2026-03-07T00:00:00Z'),
    });
    expect(r.metered).toBe(false);
    expect(store.value).toBe(0);
  });

  it('does not touch storage when allowance is zero or less, even under a deny posture', async () => {
    const store = fakeStore(0);
    const r = await reserveDaily(store, {
      namespace: 'rl:apikey:day', userId: 'u1', allowance: 0,
      ttlSeconds: 172_800, onStorageFailure: 'deny', now: new Date('2026-03-07T00:00:00Z'),
    });
    expect(r.allowed).toBe(true);
    expect(r.metered).toBe(false);
    expect(store.value).toBe(0);
  });

  it('routes a falsy userId through the deny posture instead of always allowing', async () => {
    const store = fakeStore(0);
    const r = await reserveDaily(store, {
      namespace: 'mcp:pro-usage', userId: '', allowance: 50,
      ttlSeconds: 172_800, onStorageFailure: 'deny', now: new Date('2026-03-07T00:00:00Z'),
    });
    expect(r.allowed).toBe(false);
    expect(r.metered).toBe(false);
    expect(r.reason).toBe('storage-unavailable');
    expect(store.value).toBe(0);
  });

  it('routes a falsy userId through the allow posture', async () => {
    const store = fakeStore(0);
    const r = await reserveDaily(store, {
      namespace: 'rl:apikey:day', userId: '', allowance: 10,
      ttlSeconds: 172_800, onStorageFailure: 'allow', now: new Date('2026-03-07T00:00:00Z'),
    });
    expect(r.allowed).toBe(true);
    expect(r.metered).toBe(false);
    expect(store.value).toBe(0);
  });

  it('flags overCeiling at the caller-supplied ceiling multiplier, not the default x10', async () => {
    // MCP-shaped: allowance 50, ceilingMultiplier 1 -> ceiling is 50, not 500.
    const atBoundary = fakeStore(49);
    const rAtBoundary = await reserveDaily(atBoundary, {
      namespace: 'mcp:pro-usage', userId: 'u1', allowance: 50, ceilingMultiplier: 1,
      ttlSeconds: 172_800, onStorageFailure: 'deny', now: new Date('2026-03-07T00:00:00Z'),
    });
    // count becomes 50, allowance 50 x 1 = 50, so 50 is not > 50.
    expect(rAtBoundary.overCeiling).toBe(false);

    const overBoundary = fakeStore(50);
    const rOverBoundary = await reserveDaily(overBoundary, {
      namespace: 'mcp:pro-usage', userId: 'u1', allowance: 50, ceilingMultiplier: 1,
      ttlSeconds: 172_800, onStorageFailure: 'deny', now: new Date('2026-03-07T00:00:00Z'),
    });
    // count becomes 51, allowance 50 x 1 = 50, so 51 > 50.
    expect(rOverBoundary.overCeiling).toBe(true);
  });

  it('defaults ceilingMultiplier to x10 when omitted', async () => {
    const store = fakeStore(100);
    const r = await reserveDaily(store, {
      namespace: 'rl:apikey:day', userId: 'u1', allowance: 10,
      ttlSeconds: 172_800, onStorageFailure: 'allow', now: new Date('2026-03-07T00:00:00Z'),
    });
    // count becomes 101, allowance 10 x default 10 = 100, so 101 > 100.
    expect(r.overCeiling).toBe(true);
  });
});
