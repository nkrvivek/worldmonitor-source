import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../worker/routes/bootstrap', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/bootstrap')>(
    '../../worker/routes/bootstrap',
  );
  return {
    ...actual,
    handleBootstrap: vi.fn(async () => new Response('in-worker-bootstrap', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import { handleBootstrap, isBootstrapPath } from '../../worker/routes/bootstrap';

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

describe('isBootstrapPath', () => {
  test('is true for the bootstrap endpoint', () => {
    expect(isBootstrapPath('/api/bootstrap')).toBe(true);
  });

  // The front end calls /api/bootstrap?keys=…&public=1. Query strings never
  // reach this function -- it takes a pathname -- but a trailing slash does,
  // because worker/index.ts strips one only further down the chain.
  test('is true with a trailing slash', () => {
    expect(isBootstrapPath('/api/bootstrap/')).toBe(true);
  });

  test('is false for neighbouring paths', () => {
    expect(isBootstrapPath('/api/bootstrap-tiers')).toBe(false);
    expect(isBootstrapPath('/api/market/v1/list-market-quotes')).toBe(false);
  });
});

describe('worker fetch: bootstrap routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards: /api/bootstrap fell through to the
  // UPSTREAM_API_ORIGIN proxy, where nothing answers. The site shell loaded
  // and every panel stayed empty, because this one call fills all of them.
  test('answers from the Worker, not the Vercel proxy', async () => {
    const seen: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response('upstream:proxied', { status: 200 });
    }) as typeof fetch;
    try {
      const req = new Request('https://worldmonitor.sibt.ai/api/bootstrap?keys=weather&public=1');
      const res = await worker.fetch(req, envWith());
      expect(await res.text()).toBe('in-worker-bootstrap');
      expect(handleBootstrap).toHaveBeenCalledTimes(1);
      expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
