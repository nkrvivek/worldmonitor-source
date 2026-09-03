import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../worker/routes/health', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/health')>(
    '../../worker/routes/health',
  );
  return {
    ...actual,
    handleHealth: vi.fn(async () => new Response('in-worker-health', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import { handleHealth, HEALTH_PATH, isHealthPath } from '../../worker/routes/health';

function envWith(): Env {
  return {
    ASSETS: {
      async fetch() {
        return new Response('not found', { status: 404 });
      },
    },
    UPSTREAM_API_ORIGIN: 'https://vercel-origin.worldmonitor.app',
  };
}

describe('isHealthPath', () => {
  test('is true for the bare path and its trailing-slash form', () => {
    expect(isHealthPath(HEALTH_PATH)).toBe(true);
    expect(isHealthPath(`${HEALTH_PATH}/`)).toBe(true);
  });

  // worker/routes/domains.ts serves the sebuf health service under
  // /api/health/v1/ and is matched first. If this route ever widened to a
  // prefix it would swallow that service whole.
  test('leaves the /api/health/v1/ service alone', () => {
    expect(isHealthPath('/api/health/v1/HealthService/GetHealth')).toBe(false);
    expect(isHealthPath('/api/health/v1/')).toBe(false);
  });

  test('is false for neighbouring paths', () => {
    expect(isHealthPath('/api/healthz')).toBe(false);
    expect(isHealthPath('/api/seed-health')).toBe(false);
    expect(isHealthPath('/health')).toBe(false);
  });
});

describe('worker fetch: health routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards: /api/health?compact=1 is the status URL this site
  // publishes in its own Link header, and it fell through to the
  // UPSTREAM_API_ORIGIN proxy, whose host does not resolve. The seed freshness
  // monitor reads that URL, which is why the workflow was switched off.
  test('answers from the Worker, not the Vercel proxy', async () => {
    const seen: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response('upstream:proxied', { status: 200 });
    }) as typeof fetch;
    try {
      const req = new Request(`https://worldmonitor.sibt.ai${HEALTH_PATH}?compact=1`);
      const res = await worker.fetch(req, envWith());
      expect(await res.text()).toBe('in-worker-health');
      expect(handleHealth).toHaveBeenCalledTimes(1);
      expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  // api/health.js hands its snapshot write to ctx.waitUntil when one is
  // present. Passing the ExecutionContext through is the whole reason this
  // branch takes three arguments.
  test('passes the execution context through', async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    await worker.fetch(
      new Request(`https://worldmonitor.sibt.ai${HEALTH_PATH}`),
      envWith(),
      ctx as unknown as ExecutionContext,
    );
    expect(handleHealth).toHaveBeenCalledWith(expect.any(Request), ctx);
  });
});
