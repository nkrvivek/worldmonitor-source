import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import { WM_SESSION_PATH, handleWmSession } from '../../worker/routes/wm-session';
// @ts-expect-error — JS module, no declaration file
import { setRateLimitEnv, __resetRateLimitForTest } from '../../api/_rate-limit.js';

// Fix round 1, Task 4 (2026-08-03-p4d): api/wm-session.js calls checkRateLimit
// with `failClosed: true`, and Upstash is deliberately never provisioned
// here (adding it would violate the "Cloudflare only, no new third-party
// service" constraint) — so without a CounterDO seam this route 503s in
// production every time, which is not a Worker that mints sessions. This
// file proves the CounterDO path api/_rate-limit.js now has actually admits
// a real request end to end: a real COUNTER Durable Object stub (via
// cloudflare:test's `env`, same wiring tests/counters/parity.test.mts uses
// for the sibling server/_shared/rate-limit.ts seam), no Upstash env vars at
// all, and a real HTTP round trip through handleWmSession. Asserting on the
// response status/cookie, not on how many times any mock was called.
describe('wm-session route via CounterDO (no Upstash configured)', () => {
  beforeEach(() => {
    // A fresh, test-only value — never the value in .dev.vars/the Worker
    // secret binding. Written directly here so this suite is reproducible
    // without depending on nodejs_compat's lazy process.env population
    // finding a local .dev.vars file (which may not exist, e.g. in CI).
    process.env.WM_SESSION_SECRET = 'y'.repeat(48);
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    setRateLimitEnv({
      COUNTER: {
        idFromName: (name: string) => name,
        get: (id: unknown) => env.COUNTER.get(env.COUNTER.idFromName(id as string)),
      },
    });
  });

  afterEach(() => {
    __resetRateLimitForTest();
    delete process.env.WM_SESSION_SECRET;
  });

  test('mints a wms_-prefixed token when a CounterDO stub is present and Upstash is not configured', async () => {
    const response = await handleWmSession(
      new Request(`https://worldmonitor.sibt.ai${WM_SESSION_PATH}`, {
        method: 'POST',
        // Unique per test run so this suite's sliding-window bucket never
        // collides with another test file's IP-keyed bucket in the same
        // CounterDO namespace.
        headers: { 'x-real-ip': '203.0.113.201' },
      }),
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('wms_');
    expect(setCookie).toContain('HttpOnly');
  });

  test('blocks with 429 (not 503) once the CounterDO-backed scope limit is exhausted', async () => {
    // SESSION_RATE_LIMIT_PER_MINUTE in api/wm-session.js is 30. Exhaust it
    // through the real DO, then confirm the 31st request is a real rate-limit
    // rejection, not a degraded/fail-closed response — proving the counter
    // path enforces the same budget the Upstash path would, rather than
    // silently admitting everything.
    const ip = '203.0.113.202';
    const request = () =>
      new Request(`https://worldmonitor.sibt.ai${WM_SESSION_PATH}`, {
        method: 'POST',
        headers: { 'x-real-ip': ip },
      });

    for (let i = 0; i < 30; i++) {
      const response = await handleWmSession(request());
      expect(response.status, `request ${i + 1} should mint (200)`).toBe(200);
    }
    const blocked = await handleWmSession(request());
    expect(blocked.status).toBe(429);
  });
});
