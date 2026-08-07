import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WM_SESSION_PATH, handleWmSession } from '../../worker/routes/wm-session';
// @ts-expect-error — JS module, no declaration file
import { __resetRateLimitForTest } from '../../api/_rate-limit.js';

const originalFetch = globalThis.fetch;

// api/wm-session.js's rate limiter (api/_rate-limit.js's checkRateLimit) is
// called with `failClosed: true` for this route — deliberate, per the
// comment above that call: a lower fail-closed issuance budget instead of
// the availability-first global fallback. Without Upstash configured it
// returns 503 before a token is ever minted (api/wm-session.test.mjs's own
// "Redis limiter config is missing" case proves this is real handler
// behaviour, not a bug introduced here). These fake Upstash env vars plus a
// fetch mock reproduce a successful rate-limit check, mirroring the same
// helper in api/wm-session.test.mjs.
function mockUpstashRateLimit({ remaining = 29, limit = 30 }: { remaining?: number; limit?: number } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url.includes('fake.upstash.io')) {
      return new Response(
        JSON.stringify([{ result: [remaining, limit] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

describe('wm-session route', () => {
  beforeEach(() => {
    __resetRateLimitForTest();
    process.env.WM_SESSION_SECRET = 'x'.repeat(48);
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    mockUpstashRateLimit();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  test('exposes the path the frontend actually posts to', () => {
    expect(WM_SESSION_PATH).toBe('/api/wm-session');
  });

  test('mints a wms_-prefixed token for an anonymous POST', async () => {
    const response = await handleWmSession(
      new Request('https://worldmonitor.sibt.ai/api/wm-session', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('wms_');
    expect(setCookie).toContain('HttpOnly');
  });

  test('rejects a GET — the frontend only ever POSTs', async () => {
    const response = await handleWmSession(
      new Request('https://worldmonitor.sibt.ai/api/wm-session', { method: 'GET' }),
    );
    expect(response.status).toBe(405);
  });
});

// Fix round 1, Task 4: the fail-closed posture (api/wm-session.js calls
// checkRateLimit with `failClosed: true`) must survive the CounterDO seam
// added to api/_rate-limit.js — a request that reaches this route with
// neither Upstash configured NOR a COUNTER stub wired in (this suite runs
// under plain node — vitest.worker.config.mts — so there is no Durable
// Object binding to wire one from) must still 503, not silently mint a
// token. This is the scenario the original brief's test never covered: every
// other test in this file mocks Upstash into working. Nothing to mock here —
// the absence itself is the fixture.
describe('wm-session route with neither Upstash nor a counter stub configured', () => {
  beforeEach(() => {
    // Deleting the env vars is not enough on its own. getRatelimit()
    // (api/_rate-limit.js) caches each limiter under `scope|limit|window`,
    // which carries no trace of the Redis URL, so the limiter the describe
    // above built against https://fake.upstash.io outlives its own env vars.
    // Without this reset the request below reached that dead host over the
    // real fetch and only 503'd once the connection failed — the right
    // status for the wrong reason, and a 5s timeout on CI, where the fake
    // hostname resolves slower than it does on a laptop.
    __resetRateLimitForTest();
    process.env.WM_SESSION_SECRET = 'x'.repeat(48);
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  afterEach(() => {
    delete process.env.WM_SESSION_SECRET;
  });

  test('503s instead of minting a token (fail-closed, not fail-open)', async () => {
    // The stage name is what pins this test to the missing-config branch.
    // Status and body alone cannot: every other degraded path returns the
    // same 503 with the same body, which is how the cached-limiter version
    // of this test passed for the wrong reason.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await handleWmSession(
        new Request('https://worldmonitor.sibt.ai/api/wm-session', { method: 'POST' }),
      );
      expect(response.status).toBe(503);
      const body = await response.json();
      // Distinguishes the rate-limiter's degraded response from the separate
      // "Session service not configured" 503 issueSessionToken() can also
      // return (api/wm-session.js:138-148) — this test is specifically about
      // the rate-limit branch, which runs first.
      expect(body).toEqual({ error: 'Rate-limit service temporarily unavailable' });
      expect(logged.mock.calls.map((call) => String(call[0])).join('\n'))
        .toContain('stage=checkRateLimit:missing-config');
    } finally {
      logged.mockRestore();
    }
  });
});
