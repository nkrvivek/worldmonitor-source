import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../worker/routes/oauth', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/oauth')>(
    '../../worker/routes/oauth',
  );
  return {
    ...actual,
    handleOauth: vi.fn(async () => new Response('in-worker-oauth', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import { handleOauth, isOauthPathHandledInWorker, OAUTH_ROUTE_PATHS } from '../../worker/routes/oauth';

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

describe('isOauthPathHandledInWorker', () => {
  // Named here rather than looped over the export alone: a path quietly dropped
  // from the table would still pass a loop over that same table.
  test('covers exactly the grant flow and the Pro bridge', () => {
    expect([...OAUTH_ROUTE_PATHS].sort()).toEqual([
      '/agent/auth',
      '/api/internal/mcp-grant-context',
      '/api/internal/mcp-grant-mint',
      '/oauth/authorize',
      '/oauth/authorize-pro',
      '/oauth/register',
      '/oauth/token',
    ]);
  });

  test('is true for every path in the table', () => {
    for (const path of OAUTH_ROUTE_PATHS) {
      expect(isOauthPathHandledInWorker(path)).toBe(true);
    }
  });

  test('is true with a trailing slash', () => {
    expect(isOauthPathHandledInWorker('/oauth/token/')).toBe(true);
  });

  // Exact paths, not prefixes. '/mcp-grant' is a real page on this site, and
  // '/oauth/authorize-pro' must not be reachable as a suffix of '/oauth/authorize'.
  test('is false for neighbouring paths', () => {
    expect(isOauthPathHandledInWorker('/mcp-grant')).toBe(false);
    expect(isOauthPathHandledInWorker('/oauth')).toBe(false);
    expect(isOauthPathHandledInWorker('/oauth/token/refresh')).toBe(false);
    expect(isOauthPathHandledInWorker('/api/internal/brief-why-matters')).toBe(false);
    expect(isOauthPathHandledInWorker('/agent/authx')).toBe(false);
  });
});

describe('worker fetch: OAuth routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards: a client read our discovery documents, walked to
  // /oauth/register, and hit the UPSTREAM_API_ORIGIN proxy, whose host does not
  // resolve. The grant flow ended in a 530 every time.
  test.each([...OAUTH_ROUTE_PATHS])('%s answers from the Worker, not the Vercel proxy', async (path) => {
    const seen: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response('upstream:proxied', { status: 200 });
    }) as typeof fetch;
    try {
      const req = new Request(`https://worldmonitor.sibt.ai${path}`, { method: 'POST' });
      const res = await worker.fetch(req, envWith());
      expect(await res.text()).toBe('in-worker-oauth');
      expect(handleOauth).toHaveBeenCalledTimes(1);
      expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
