import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { callCounter } from '../../worker/counters/protocol';
import {
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
  GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES,
  RATE_LIMIT_MUTATION_FALLBACK_EXEMPT,
  checkRateLimit,
  checkEndpointRateLimit,
  checkScopedRateLimit,
  setRateLimitEnv,
  __resetRateLimitForTest,
} from '../../server/_shared/rate-limit';

function stubFor(name: string) {
  return env.COUNTER.get(env.COUNTER.idFromName(name));
}

function makeRequest(ip: string): Request {
  return new Request('https://worldmonitor.app/api/test', { headers: { 'x-real-ip': ip } });
}

// --- Policy-table shape/count parity ---
//
// These pin the CURRENT, verified-by-reading-the-file counts. The task-4
// brief expected ENDPOINT_RATE_POLICIES to hold 16 entries; the file on disk
// holds 17 (the mcp-proxy / a2a / ask trio at the bottom, added after the
// brief was written per #3805 / PR #3821). Per this plan's own precedent
// (tasks 1-3: trust the code over a stale brief, document the gap, proceed),
// this test pins the real count, not the brief's stale one. If a count ever
// changes, scripts/enforce-rate-limit-policies.mjs and this test both need a
// matching, deliberate update; a silent mismatch here would mean recon
// (either the brief's or this test's) is wrong again.
//
// Bumped 17 → 24 / 13 → 18 / 1 → 2 when upstream/main merged into the port.
// Upstream added six /api/intelligence/v1/* routes plus /api/docs-mcp; five of
// the six intelligence routes are also fail-closed-required, and
// list-material-events joined the global fallback-read set. Verified by
// diffing the key sets against pre-merge main: seven additions, zero removals,
// zero duplicate keys. The pins moved because the tables genuinely grew, not
// because the merge doubled anything up.
describe('rate-limit policy tables (parity with server/_shared/rate-limit.ts)', () => {
  it('ENDPOINT_RATE_POLICIES holds exactly 24 routes', () => {
    expect(Object.keys(ENDPOINT_RATE_POLICIES)).toHaveLength(24);
  });

  it('FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED holds exactly 18 routes', () => {
    expect(Object.keys(FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED)).toHaveLength(18);
  });

  it('GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES holds exactly 2 routes', () => {
    expect(Object.keys(GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES)).toHaveLength(2);
  });

  it('RATE_LIMIT_MUTATION_FALLBACK_EXEMPT holds exactly 3 routes', () => {
    expect(Object.keys(RATE_LIMIT_MUTATION_FALLBACK_EXEMPT)).toHaveLength(3);
  });

  it('every fail-closed-required route has a matching endpoint policy', () => {
    for (const pathname of Object.keys(FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED)) {
      expect(ENDPOINT_RATE_POLICIES[pathname], `missing ENDPOINT_RATE_POLICIES entry for ${pathname}`).toBeDefined();
    }
  });

  it('every policy has a positive limit and a parseable window', () => {
    for (const [pathname, policy] of Object.entries(ENDPOINT_RATE_POLICIES)) {
      expect(policy.limit, pathname).toBeGreaterThan(0);
      expect(policy.window, pathname).toMatch(/^\d+\s?(ms|s|m|h|d)$/);
    }
  });
});

// --- Raw CounterDO parity: the sliding-window primitive the limiters above
// now call through, exercised directly against a real Durable Object at the
// production global limit (600/min) rather than through any TypeScript
// wrapper. ---
describe('CounterDO raw parity at the production global rate (600/min)', () => {
  it('admits exactly 600 requests in a window, then rejects the 601st', async () => {
    const stub = stubFor('parity-global-600');
    const req = { op: 'sliding', key: 'ip:parity-global', limit: 600, windowMs: 60_000 } as const;

    for (let i = 0; i < 600; i++) {
      const r = await callCounter(stub, req);
      expect(r.op === 'sliding' && r.success, `request ${i + 1} should be admitted`).toBe(true);
    }
    const denied = await callCounter(stub, req);
    expect(denied.op === 'sliding' && denied.success).toBe(false);
  });
});

// --- Integration parity: the real exported limiter functions, wired to a
// real CounterDO stub via setRateLimitEnv, prove the new branch this task
// added is not dead code — it actually admits/rejects through the DO. ---
describe('checkRateLimit / checkEndpointRateLimit / checkScopedRateLimit via CounterDO', () => {
  beforeEach(() => {
    setRateLimitEnv({
      COUNTER: {
        idFromName: (name: string) => name,
        get: (id: unknown) => env.COUNTER.get(env.COUNTER.idFromName(id as string)),
      },
    });
  });

  afterEach(() => {
    __resetRateLimitForTest();
  });

  it('checkRateLimit admits up to the global 600/min limit, then blocks with 429', async () => {
    const ip = '203.0.113.50';
    const request = makeRequest(ip);
    for (let i = 0; i < 600; i++) {
      const res = await checkRateLimit(request, {});
      expect(res, `request ${i + 1} should pass through (null)`).toBeNull();
    }
    const blocked = await checkRateLimit(request, {});
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
  });

  it('checkEndpointRateLimit enforces the route policy limit through the DO', async () => {
    // submit-contact: limit 3 / window 1h — small on purpose to keep this fast.
    const pathname = '/api/leads/v1/submit-contact';
    const policy = ENDPOINT_RATE_POLICIES[pathname];
    expect(policy).toBeDefined();
    const request = makeRequest('203.0.113.60');

    for (let i = 0; i < policy!.limit; i++) {
      const res = await checkEndpointRateLimit(request, pathname, {});
      expect(res, `request ${i + 1} should pass through (null)`).toBeNull();
    }
    const blocked = await checkEndpointRateLimit(request, pathname, {});
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
  });

  it('checkScopedRateLimit reports allowed:false (not degraded) once the DO-backed scope is exhausted', async () => {
    const scope = 'parity-scope-test';
    const identifier = '203.0.113.70';
    for (let i = 0; i < 3; i++) {
      const result = await checkScopedRateLimit(scope, 3, '60 s', identifier);
      expect(result.degraded, `attempt ${i + 1} should not be degraded`).toBe(false);
      expect(result.allowed, `attempt ${i + 1} should be allowed`).toBe(true);
    }
    const blocked = await checkScopedRateLimit(scope, 3, '60 s', identifier);
    expect(blocked.degraded).toBe(false);
    expect(blocked.allowed).toBe(false);
  });
});
