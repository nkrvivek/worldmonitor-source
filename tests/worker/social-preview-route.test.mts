import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../worker/routes/social-preview', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/social-preview')>(
    '../../worker/routes/social-preview',
  );
  return {
    ...actual,
    handleSocialPreview: vi.fn(async () => new Response('in-worker-social-preview', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import {
  handleSocialPreview,
  isSocialPreviewPathHandledInWorker,
  SOCIAL_PREVIEW_ROUTE_PATHS,
} from '../../worker/routes/social-preview';

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

describe('isSocialPreviewPathHandledInWorker', () => {
  // Named here rather than looped over the export alone: a path quietly dropped
  // from the table would still pass a loop over that same table.
  test('covers the card and the image it embeds', () => {
    expect([...SOCIAL_PREVIEW_ROUTE_PATHS].sort()).toEqual(['/api/og-story', '/api/story']);
  });

  test('is true for every path in the table', () => {
    for (const path of SOCIAL_PREVIEW_ROUTE_PATHS) {
      expect(isSocialPreviewPathHandledInWorker(path)).toBe(true);
    }
  });

  test('is true with a trailing slash', () => {
    expect(isSocialPreviewPathHandledInWorker('/api/story/')).toBe(true);
  });

  test('is false for neighbouring paths', () => {
    expect(isSocialPreviewPathHandledInWorker('/api/stories')).toBe(false);
    expect(isSocialPreviewPathHandledInWorker('/api/story/UA')).toBe(false);
    expect(isSocialPreviewPathHandledInWorker('/story')).toBe(false);
  });
});

describe('worker fetch: social preview routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards: someone shared a country brief, the crawler fetched
  // /api/story, and the request fell through to the UPSTREAM_API_ORIGIN proxy,
  // whose host does not resolve. Every share card from this fork was dead.
  test.each([...SOCIAL_PREVIEW_ROUTE_PATHS])(
    '%s answers from the Worker, not the Vercel proxy',
    async (path) => {
      const seen: string[] = [];
      const originalFetch = global.fetch;
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        seen.push(typeof input === 'string' ? input : input.toString());
        return new Response('upstream:proxied', { status: 200 });
      }) as typeof fetch;
      try {
        const req = new Request(`https://worldmonitor.sibt.ai${path}?c=UA`);
        const res = await worker.fetch(req, envWith());
        expect(await res.text()).toBe('in-worker-social-preview');
        expect(handleSocialPreview).toHaveBeenCalledTimes(1);
        expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
    },
  );
});
