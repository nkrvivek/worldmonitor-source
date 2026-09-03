import assert from 'node:assert/strict';
import test from 'node:test';

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

// Captured at module load, before any test swaps globalThis.fetch for a stub,
// so a stub that stalls one host can still pass everything else through.
const realFetch = globalThis.fetch;

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('frontend session mint must not block API callers forever', async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { location: Location }).location = {
    href: 'https://worldmonitor.app/',
    origin: 'https://worldmonitor.app',
    hostname: 'worldmonitor.app',
    protocol: 'https:',
    host: 'worldmonitor.app',
  } as Location;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage();
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_input, init) => new Promise<Response>((_, reject) => {
    if (init?.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  })) as typeof fetch;

  const mod = await import('../src/services/wm-session.ts');
  mod.__resetWmSessionForTests();
  mod.__setWmSessionFetchTimeoutForTests(50);

  const outcomes = await Promise.all(Array.from({ length: 100 }, async () => Promise.race([
    mod.ensureWmSession().then(() => 'settled'),
    after(500, 'still-pending'),
  ])));

  assert.equal(outcomes.filter((value) => value === 'still-pending').length, 0);
  mod.__resetWmSessionForTests();
});

test('wm-session request-body read must terminate for a body that never ends', async () => {
  process.env.WM_SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.WM_SESSION_BODY_TIMEOUT_MS = '50';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ result: [29, 30] }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const { default: handler } = await import('../api/wm-session.js');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"widgetKey":"'));
      },
    });
    const req = new Request('https://api.worldmonitor.app/api/wm-session', {
      method: 'POST',
      headers: {
        origin: 'https://worldmonitor.app',
        'content-type': 'application/json',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const outcome = await Promise.race([
      handler(req).then(() => 'settled'),
      after(500, 'still-pending'),
    ]);
    assert.equal(outcome, 'settled');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WM_SESSION_BODY_TIMEOUT_MS;
  }
});

test('widget-agent request-body read must terminate for a body that never ends', async () => {
  process.env.WIDGET_AGENT_KEY = 'server-widget-key';
  process.env.PRO_WIDGET_KEY = 'server-pro-key';
  process.env.WORLDMONITOR_VALID_KEYS = 'browser-test-key';
  process.env.WIDGET_AGENT_BODY_TIMEOUT_MS = '50';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => never<Response>()) as typeof fetch;
  try {
    const { default: handler } = await import('../api/widget-agent.ts?resource-repro=1');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"prompt":"'));
      },
    });
    const req = new Request('https://www.worldmonitor.app/api/widget-agent', {
      method: 'POST',
      headers: {
        Origin: 'https://www.worldmonitor.app',
        'Content-Type': 'application/json',
        'X-WorldMonitor-Key': 'browser-test-key',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const outcome = await Promise.race([
      handler(req).then(() => 'settled'),
      after(500, 'still-pending'),
    ]);
    assert.equal(outcome, 'settled');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WIDGET_AGENT_BODY_TIMEOUT_MS;
  }
});

test('__resetWmSessionForTests restores the default mint timeout', async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { location: Location }).location = {
    href: 'https://worldmonitor.app/',
    origin: 'https://worldmonitor.app',
    hostname: 'worldmonitor.app',
    protocol: 'https:',
    host: 'worldmonitor.app',
  } as Location;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage();
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_input, init) => new Promise<Response>((resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    setTimeout(() => resolve(new Response(JSON.stringify({ exp: Date.now() + 3600000 }))), 100);
  })) as typeof fetch;

  const mod = await import('../src/services/wm-session.ts?reset-timeout-repro=1');
  mod.__setWmSessionFetchTimeoutForTests(50);
  mod.__resetWmSessionForTests();

  const outcome = await Promise.race([
    mod.ensureWmSession().then(() => 'settled'),
    after(500, 'still-pending'),
  ]);
  assert.equal(outcome, 'settled');
});

// Every Pro gate calls getEntitlements on the request path, so an unbounded
// lookup pins the whole gateway. Under Clerk this bound lived in auth-session's
// own plan fetch; the Supabase port deleted that fetch, and this is where the
// remaining one is.
test('entitlement lookup must not pin the gateway when Convex never responds', async () => {
  process.env.CONVEX_SITE_URL = 'https://convex-stall.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'test-shared-secret';
  // No Upstash config, so the Redis leg answers from memory and only the
  // Convex fetch below can stall.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const originalFetch = globalThis.fetch;
  let convexCalls = 0;
  globalThis.fetch = ((input, init) => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url;
    if (!url.startsWith('https://convex-stall.test/')) return realFetch(input, init);
    convexCalls += 1;
    return new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  }) as typeof fetch;

  try {
    const { getEntitlements } = await import('../server/_shared/entitlement-check.ts?stall-repro=1');

    // The bound is the lookup's own AbortSignal.timeout(3_000), so the race
    // window sits above it. What this pins is that SOME bound exists: drop the
    // signal and this call never settles.
    const settled = await Promise.race([
      getEntitlements('user_entitlement_stall'),
      after(6_000, 'still-pending' as const),
    ]);
    assert.notEqual(settled, 'still-pending', 'a stalled entitlement lookup must not keep the request pending');
    assert.equal(convexCalls, 1);

    // A lookup that could not answer must not read as a verdict about the plan.
    // The marker is what turns the gates' denial into a retryable 503 instead of
    // selling a paying customer the plan they already own (#5619).
    const entitlements = settled as { verificationUnavailable?: boolean } | null;
    assert.equal(entitlements?.verificationUnavailable, true);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
  }
});
