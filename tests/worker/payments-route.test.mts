import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../worker/routes/payments', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/payments')>(
    '../../worker/routes/payments',
  );
  return {
    ...actual,
    handlePaymentRpc: vi.fn(async () => new Response('in-worker-payments', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import {
  handlePaymentRpc,
  isPaymentPathHandledInWorker,
  PAYMENT_ROUTE_PATHS,
} from '../../worker/routes/payments';

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

describe('isPaymentPathHandledInWorker', () => {
  // Naming the four here rather than looping the export alone: a route quietly
  // dropped from the table would still pass a loop over that same table.
  test('covers exactly the four payments endpoints', () => {
    expect([...PAYMENT_ROUTE_PATHS].sort()).toEqual([
      '/api/create-checkout',
      '/api/customer-portal',
      '/api/me/entitlement',
      '/api/product-catalog',
    ]);
  });

  test('is true for every path in the table', () => {
    for (const path of PAYMENT_ROUTE_PATHS) {
      expect(isPaymentPathHandledInWorker(path)).toBe(true);
    }
  });

  test('is true with a trailing slash', () => {
    expect(isPaymentPathHandledInWorker('/api/product-catalog/')).toBe(true);
  });

  // Exact paths, not prefixes: a prefix match on '/api/me/' would swallow
  // every future account route into the entitlement handler.
  test('is false for neighbouring paths', () => {
    expect(isPaymentPathHandledInWorker('/api/me/api-keys')).toBe(false);
    expect(isPaymentPathHandledInWorker('/api/me/entitlement/history')).toBe(false);
    expect(isPaymentPathHandledInWorker('/api/product-catalog-v2')).toBe(false);
    expect(isPaymentPathHandledInWorker('/api/bootstrap')).toBe(false);
  });
});

describe('worker fetch: payments routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards: all four fell through to the UPSTREAM_API_ORIGIN
  // proxy, where nothing answers. The pricing page showed its static fallback
  // and checkout 404'd.
  test.each(['/api/product-catalog', '/api/create-checkout', '/api/customer-portal', '/api/me/entitlement'])(
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
        expect(await res.text()).toBe('in-worker-payments');
        expect(handlePaymentRpc).toHaveBeenCalledTimes(1);
        expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
    },
  );
});
