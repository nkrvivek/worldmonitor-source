import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../worker/routes/plain-api', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/plain-api')>(
    '../../worker/routes/plain-api',
  );
  return {
    ...actual,
    handlePlainApi: vi.fn(async () => new Response('in-worker-plain-api', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import {
  handlePlainApi,
  isPlainApiPathHandledInWorker,
  PLAIN_API_ROUTE_PATHS,
} from '../../worker/routes/plain-api';

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

describe('isPlainApiPathHandledInWorker', () => {
  // Named here rather than looped over the export alone: a path quietly dropped
  // from the table would still pass a loop over that same table.
  test('covers the endpoints this batch ported', () => {
    expect([...PLAIN_API_ROUTE_PATHS].sort()).toEqual([
      '/api/chat-analyst',
      '/api/download',
      '/api/fwdstart',
      '/api/gpsjam',
      '/api/invalidate-user-api-key-cache',
      '/api/latest-brief',
      '/api/mcp-proxy',
      '/api/notification-channels',
      '/api/notify',
      '/api/opensky',
      '/api/oref-alerts',
      '/api/referral/me',
      '/api/reverse-geocode',
      '/api/rss-proxy',
      '/api/skills/fetch-agentskills',
      '/api/slack/oauth/callback',
      '/api/slack/oauth/start',
      '/api/supply-chain/hormuz-tracker',
      '/api/symbol-search',
      '/api/telegram-feed',
      '/api/user-prefs',
      '/api/user/mcp-quota',
      '/api/user/mcp-revoke',
      '/api/version',
      '/api/youtube/live',
    ]);
  });

  // Both are handlers that exist in api/ and stay unrouted on purpose. See the
  // header comment in worker/routes/plain-api.ts for why.
  test('is false for the handlers held back on purpose', () => {
    expect(isPlainApiPathHandledInWorker('/api/discord/oauth/start')).toBe(false);
    expect(isPlainApiPathHandledInWorker('/api/discord/oauth/callback')).toBe(false);
    expect(isPlainApiPathHandledInWorker('/api/widget-agent')).toBe(false);
  });

  test('is true for every path in the table', () => {
    for (const path of PLAIN_API_ROUTE_PATHS) {
      expect(isPlainApiPathHandledInWorker(path)).toBe(true);
    }
  });

  test('is true with a trailing slash', () => {
    expect(isPlainApiPathHandledInWorker('/api/version/')).toBe(true);
  });

  // Exact paths, not prefixes. The sebuf domain gateways own everything under
  // /api/supply-chain/v1/, and this table must not reach into them.
  test('is false for neighbouring paths', () => {
    expect(isPlainApiPathHandledInWorker('/api/versions')).toBe(false);
    expect(isPlainApiPathHandledInWorker('/api/version/latest')).toBe(false);
    expect(isPlainApiPathHandledInWorker('/api/supply-chain/v1/get-route-impact')).toBe(false);
    expect(isPlainApiPathHandledInWorker('/api/youtube/embed')).toBe(false);
  });
});

describe('worker fetch: plain API routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards: the handler sat in api/ and the SPA called the path,
  // but nothing in the Worker matched it, so the request fell through to the
  // UPSTREAM_API_ORIGIN proxy and 404'd.
  test.each([...PLAIN_API_ROUTE_PATHS])(
    '%s answers from the Worker, not the Vercel proxy',
    async (path) => {
      const seen: string[] = [];
      const originalFetch = global.fetch;
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        seen.push(typeof input === 'string' ? input : input.toString());
        return new Response('upstream:proxied', { status: 200 });
      }) as typeof fetch;
      try {
        const req = new Request(`https://worldmonitor.sibt.ai${path}`);
        const res = await worker.fetch(req, envWith());
        expect(await res.text()).toBe('in-worker-plain-api');
        expect(handlePlainApi).toHaveBeenCalledTimes(1);
        expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
    },
  );
});

describe('handlePlainApi', () => {
  // The real dispatcher, not the mock: vi.importActual above keeps the module's
  // own export reachable through the actual spread.
  test('a path outside the table gets a 404 rather than a crash', async () => {
    const actual = await vi.importActual<typeof import('../../worker/routes/plain-api')>(
      '../../worker/routes/plain-api',
    );
    const res = await actual.handlePlainApi(
      new Request('https://worldmonitor.sibt.ai/api/not-in-the-table'),
    );
    expect(res.status).toBe(404);
  });
});
