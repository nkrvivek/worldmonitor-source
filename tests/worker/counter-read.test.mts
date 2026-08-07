import { afterEach, describe, expect, test, vi } from 'vitest';
import worker, { type Env } from '../../worker/index';
import {
  signInternalMcpRequest,
  buildInternalMcpHeaders,
  INTERNAL_MCP_TIMESTAMP_WINDOW_SECONDS,
} from '../../server/_shared/mcp-internal-hmac';
import { slidingWindowDecide, type WindowState } from '../../worker/counters/sliding-window';
import { reserveDaily, dailyKey, dailyMeterShardName, type MeterStore } from '../../worker/counters/daily-meter';
import { COUNTER_READ_ROUTE_RATE_LIMIT } from '../../worker/routes/counter-read';
import type { CounterRequest, CounterResponse } from '../../worker/counters/protocol';

const PATH = '/internal/counter/daily-read';
const URL_BASE = 'https://worker.example';
const SECRET = 'test-counter-read-secret';
const NAMESPACE = 'rl:apikey:day';

/**
 * In-memory stand-in for CounterDO. This test runs under vitest.worker.
 * config.mts's plain-Node environment (no `cloudflare:workers`, see worker/
 * entry.ts's comment on why the real DO class can't be imported here), so
 * this rebuilds just enough of the real dispatch (worker/counters/counter-
 * do.ts) using the SAME pure-TS primitives the real DO calls
 * (slidingWindowDecide, reserveDaily), keyed per-shard the same way
 * idFromName isolates real instances. Only the ops this route actually
 * uses ('sliding', 'daily', 'daily-read') are implemented.
 */
interface FakeShardState {
  windows: Map<string, WindowState>;
  counters: Map<string, number>;
}

async function dispatch(req: CounterRequest, state: FakeShardState): Promise<CounterResponse> {
  switch (req.op) {
    case 'sliding': {
      const now = Date.now();
      const key = `w:${req.key}`;
      const stored = state.windows.get(key);
      const windowStart = Math.floor(now / req.windowMs) * req.windowMs;
      let win: WindowState;
      if (!stored) {
        win = { currentCount: 0, previousCount: 0, windowStart };
      } else if (stored.windowStart === windowStart) {
        win = stored;
      } else if (stored.windowStart === windowStart - req.windowMs) {
        win = { currentCount: 0, previousCount: stored.currentCount, windowStart };
      } else {
        win = { currentCount: 0, previousCount: 0, windowStart };
      }
      const decision = slidingWindowDecide(win, now, req.limit, req.windowMs);
      if (decision.success) {
        state.windows.set(key, { ...win, currentCount: win.currentCount + 1 });
      }
      return { op: 'sliding', success: decision.success, limit: decision.limit, reset: decision.reset };
    }
    case 'daily': {
      const store: MeterStore = {
        increment: async (key: string, _ttlSeconds: number) => {
          const next = (state.counters.get(key) ?? 0) + 1;
          state.counters.set(key, next);
          return next;
        },
        decrement: async (key: string) => {
          const current = state.counters.get(key) ?? 0;
          if (current > 0) state.counters.set(key, current - 1);
        },
      };
      const result = await reserveDaily(store, {
        namespace: req.namespace,
        userId: req.userId,
        allowance: req.allowance,
        ttlSeconds: req.ttlSeconds,
        onStorageFailure: req.posture,
        now: new Date(),
        ceilingMultiplier: req.ceilingMultiplier,
      });
      return {
        op: 'daily',
        allowed: result.allowed,
        metered: result.metered,
        count: result.count,
        overCeiling: result.overCeiling,
        reason: result.reason,
      };
    }
    case 'daily-read': {
      const key = dailyKey(req.namespace, req.userId, new Date());
      const value = state.counters.get(key);
      return { op: 'daily-read', count: value ?? 0, present: value !== undefined };
    }
    case 'nonce-check': {
      // Mirrors worker/counters/counter-do.ts's real nonceCheck(): storage
      // key is `${namespace}:${nonce}` -- no date component, unlike
      // 'daily'/dailyKey() -- so this test double is only faithful to the
      // real DO if it does NOT fold in `new Date()` anywhere here. TTL
      // expiry itself is real CounterDO's job (the alarm sweep); this fake
      // only needs to answer "have I seen this nonce," which is what the
      // route actually depends on.
      const key = `${req.namespace}:${req.nonce}`;
      const next = (state.counters.get(key) ?? 0) + 1;
      state.counters.set(key, next);
      return { op: 'nonce-check', seen: next > 1, metered: true };
    }
    default:
      throw new Error(`fake counter test double does not implement op: ${(req as { op: string }).op}`);
  }
}

function makeFakeCounterNamespace(): NonNullable<Env['COUNTER']> {
  const shards = new Map<string, FakeShardState>();
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = id as string;
      let state = shards.get(name);
      if (!state) {
        state = { windows: new Map(), counters: new Map() };
        shards.set(name, state);
      }
      return {
        async fetch(request: Request): Promise<Response> {
          const req = (await request.json()) as CounterRequest;
          const result = await dispatch(req, state!);
          return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
        },
      };
    },
  };
}

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {
      async fetch(request: Request) {
        request.body?.getReader();
        return new Response('not found', { status: 404 });
      },
    },
    UPSTREAM_API_ORIGIN: 'https://vercel-origin.worldmonitor.app',
    COUNTER: makeFakeCounterNamespace(),
    COUNTER_INTERNAL_HMAC_SECRET: SECRET,
    ...overrides,
  };
}

async function signedRequest(opts: {
  namespace?: string;
  userId?: string;
  secret?: string;
  now?: number;
  bodyOverride?: string;
}): Promise<Request> {
  const namespace = opts.namespace ?? NAMESPACE;
  const userId = opts.userId ?? 'user-1';
  const bodyStr = JSON.stringify({ namespace });
  const signed = await signInternalMcpRequest({
    method: 'POST',
    url: `${URL_BASE}${PATH}`,
    body: bodyStr,
    userId,
    secret: opts.secret ?? SECRET,
    now: opts.now,
  });
  return new Request(`${URL_BASE}${PATH}`, {
    method: 'POST',
    body: opts.bodyOverride ?? bodyStr,
    headers: { 'content-type': 'application/json', ...buildInternalMcpHeaders(signed) },
  });
}

describe('POST /internal/counter/daily-read', () => {
  afterEach(() => {
    // Safety net: if a fake-timer test throws before its own finally runs,
    // don't leave the process clock mocked for every test after it.
    vi.useRealTimers();
  });

  test('a correctly signed request returns present/count', async () => {
    const env = envWith();
    const req = await signedRequest({ userId: 'user-present-test' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false, count: 0 });
  });

  test('reports a real count once the underlying meter has been written', async () => {
    const env = envWith();
    // Seed the same shard the route itself reads, using the same
    // namespace:userId shard-naming scheme worker/counters/daily-meter.ts
    // exports as dailyMeterShardName -- the ASSUMPTION documented there
    // about Task 6b needing to match it.
    const userId = 'user-seeded';
    const stub = env.COUNTER!.get(env.COUNTER!.idFromName(dailyMeterShardName(NAMESPACE, userId)));
    await stub.fetch(
      new Request('https://counter.internal/', {
        method: 'POST',
        body: JSON.stringify({
          op: 'daily', namespace: NAMESPACE, userId, allowance: 10, ttlSeconds: 172_800, posture: 'allow',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    const req = await signedRequest({ userId });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: true, count: 1 });
  });

  test('an unsigned request 401s', async () => {
    const env = envWith();
    const req = new Request(`${URL_BASE}${PATH}`, {
      method: 'POST',
      body: JSON.stringify({ namespace: NAMESPACE }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  test('a tampered body 401s', async () => {
    const env = envWith();
    // Sign one body, send a different one under the same headers -- the
    // bodyHash folded into the signature no longer matches.
    const req = await signedRequest({ bodyOverride: JSON.stringify({ namespace: 'mcp:pro-usage' }) });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  test('a signature older than the timestamp window 401s', async () => {
    const env = envWith();
    const stale = Math.floor(Date.now() / 1000) - (INTERNAL_MCP_TIMESTAMP_WINDOW_SECONDS + 10);
    const req = await signedRequest({ now: stale });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  test('the same signed request replayed 401s on the second attempt', async () => {
    const env = envWith();
    const bodyStr = JSON.stringify({ namespace: NAMESPACE });
    const signed = await signInternalMcpRequest({
      method: 'POST', url: `${URL_BASE}${PATH}`, body: bodyStr, userId: 'user-replay', secret: SECRET,
    });
    const headers = { 'content-type': 'application/json', ...buildInternalMcpHeaders(signed) };
    const first = await worker.fetch(new Request(`${URL_BASE}${PATH}`, { method: 'POST', body: bodyStr, headers }), env);
    expect(first.status).toBe(200);
    const second = await worker.fetch(new Request(`${URL_BASE}${PATH}`, { method: 'POST', body: bodyStr, headers }), env);
    expect(second.status).toBe(401);
  });

  test('the same signed request replayed across a UTC-midnight boundary still 401s', async () => {
    // The regression this whole fix targets: a captured signed request is
    // still inside the HMAC's own timestamp window (INTERNAL_MCP_TIMESTAMP_
    // WINDOW_SECONDS, +/-30s) when replayed a few seconds later. If the
    // nonce-replay guard were keyed by calendar day (the pre-fix bug), a
    // replay landing on the other side of a UTC-midnight boundary would
    // compute a different storage key and slip past the guard. Neither the
    // route nor verifyInternalMcpRequest exposes an injectable clock, so
    // this moves the real process clock with vi.setSystemTime -- the same
    // Date the route, the fake CounterDO dispatch, and the signer all read.
    const env = envWith();
    const bodyStr = JSON.stringify({ namespace: NAMESPACE });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-03T23:59:50.000Z'));
      const signed = await signInternalMcpRequest({
        method: 'POST', url: `${URL_BASE}${PATH}`, body: bodyStr, userId: 'user-midnight-replay', secret: SECRET,
      });
      const headers = { 'content-type': 'application/json', ...buildInternalMcpHeaders(signed) };

      const first = await worker.fetch(new Request(`${URL_BASE}${PATH}`, { method: 'POST', body: bodyStr, headers }), env);
      expect(first.status).toBe(200);

      // 20s later, across midnight -- still inside the +/-30s HMAC window, so
      // verifyInternalMcpRequest still accepts the signature. Only the nonce
      // guard can catch this replay now.
      vi.setSystemTime(new Date('2026-08-04T00:00:10.000Z'));
      const second = await worker.fetch(new Request(`${URL_BASE}${PATH}`, { method: 'POST', body: bodyStr, headers }), env);
      expect(second.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a namespace outside the allowlist 400s', async () => {
    const env = envWith();
    const req = await signedRequest({ namespace: 'mcp:pro-usage' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  test('GET 405s', async () => {
    const env = envWith();
    const res = await worker.fetch(new Request(`${URL_BASE}${PATH}`, { method: 'GET' }), env);
    expect(res.status).toBe(405);
  });

  test('an absent secret 401s rather than throwing or falling open', async () => {
    const env = envWith({ COUNTER_INTERNAL_HMAC_SECRET: undefined });
    const req = await signedRequest({});
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  test('an absent COUNTER binding 401s rather than throwing or falling open', async () => {
    const env = envWith({ COUNTER: undefined });
    const req = await signedRequest({});
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  test('the route rate-limits itself independent of which user is targeted', async () => {
    const env = envWith();
    // 60/min ample budget; drive COUNTER_READ_ROUTE_RATE_LIMIT distinct-user
    // requests through -- still one route-level bucket per requirement 7
    // ("key the window on the route, not on the target userId") -- then
    // confirm the next one 429s.
    for (let i = 0; i < COUNTER_READ_ROUTE_RATE_LIMIT; i++) {
      const req = await signedRequest({ userId: `rl-user-${i}` });
      const res = await worker.fetch(req, env);
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const blocked = await signedRequest({ userId: 'rl-user-over-limit' });
    const res = await worker.fetch(blocked, env);
    expect(res.status).toBe(429);
  });
});
