import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// setRelayFetch keeps its real behaviour; the spy is only there so a test can
// assert the Worker installs the relay override before dispatching.
vi.mock('../../server/_shared/relay', async () => {
  const actual =
    await vi.importActual<typeof import('../../server/_shared/relay')>(
      '../../server/_shared/relay',
    );
  return { ...actual, setRelayFetch: vi.fn(actual.setRelayFetch) };
});

vi.mock('../../worker/routes/domains', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/domains')>(
    '../../worker/routes/domains',
  );
  return {
    ...actual,
    handleDomainRpc: vi.fn(async () => new Response('in-worker-gateway', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import { relayFetch, setRelayFetch } from '../../server/_shared/relay';
import {
  DOMAIN_ROUTE_PREFIXES,
  handleDomainRpc,
  isDomainPathHandledInWorker,
} from '../../worker/routes/domains';

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

describe('isDomainPathHandledInWorker', () => {
  test('covers every domain the repo ships a handler for', () => {
    // 34 v1 domains plus shipping v2. A new handler directory with no table
    // entry silently keeps 404ing, which is the failure this number catches.
    expect(DOMAIN_ROUTE_PREFIXES).toHaveLength(35);
    for (const prefix of DOMAIN_ROUTE_PREFIXES) {
      expect(isDomainPathHandledInWorker(`${prefix}some-rpc`)).toBe(true);
    }
  });

  test('is true for the RPCs the panels read', () => {
    expect(isDomainPathHandledInWorker('/api/market/v1/list-market-quotes')).toBe(true);
    expect(isDomainPathHandledInWorker('/api/maritime/v1/get-vessel-snapshot')).toBe(true);
    expect(isDomainPathHandledInWorker('/api/supply-chain/v1/get-chokepoint-status')).toBe(true);
    expect(isDomainPathHandledInWorker('/api/intelligence/v1/list-market-implications')).toBe(true);
    expect(isDomainPathHandledInWorker('/api/v2/shipping/get-port-congestion')).toBe(true);
  });

  test('is false for paths that are not domain RPCs', () => {
    expect(isDomainPathHandledInWorker('/api/bootstrap')).toBe(false);
    expect(isDomainPathHandledInWorker('/api/create-checkout')).toBe(false);
    expect(isDomainPathHandledInWorker('/ais/snapshot')).toBe(false);
    expect(isDomainPathHandledInWorker('/dashboard')).toBe(false);
    // Right prefix shape, no such domain.
    expect(isDomainPathHandledInWorker('/api/nonesuch/v1/anything')).toBe(false);
  });
});

describe('worker fetch: domain RPC routing', () => {
  // vi.mock is module-scoped, so the mocked handler carries call counts across
  // tests unless they are cleared.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const path of [
    '/api/market/v1/list-market-quotes',
    '/api/supply-chain/v1/get-chokepoint-status',
    '/api/economic/v1/list-economic-indicators',
  ]) {
    test(`answers ${path} in-Worker instead of proxying upstream`, async () => {
      const seen: string[] = [];
      const originalFetch = global.fetch;
      global.fetch = vi.fn(async (input: RequestInfo | URL) => {
        seen.push(typeof input === 'string' ? input : input.toString());
        return new Response('upstream:proxied', { status: 200 });
      }) as typeof fetch;
      try {
        const res = await worker.fetch(
          new Request(`https://www.worldmonitor.app${path}`),
          envWith(),
        );
        expect(await res.text()).toBe('in-worker-gateway');
        expect(handleDomainRpc).toHaveBeenCalledTimes(1);
        expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
    });
  }
});

describe('handleDomainRpc installs the relay override', () => {
  // Before the table existed, only the maritime branch installed it. Supply
  // chain's getChokepointStatus and getRouteImpact reach getVesselSnapshot too,
  // so an isolate whose first request was supply-chain fetched the Worker's own
  // hostname and timed out at HTTP 522.
  const originalRelayUrl = process.env.WS_RELAY_URL;

  beforeEach(() => {
    setRelayFetch(null);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalRelayUrl === undefined) delete process.env.WS_RELAY_URL;
    else process.env.WS_RELAY_URL = originalRelayUrl;
  });

  // The override answers relay calls that name this Worker, so the request
  // origin and WS_RELAY_URL have to be the same host here, as they are in
  // production.
  test('every domain gets it, not just maritime', async () => {
    process.env.WS_RELAY_URL = 'https://www.worldmonitor.app';
    const { handleDomainRpc: realHandleDomainRpc } = await vi.importActual<
      typeof import('../../worker/routes/domains')
    >('../../worker/routes/domains');

    const seen = { search: null as string | null };
    const env = {
      AIS_RELAY: {
        idFromName: (name: string) => name,
        get: () => ({
          async fetch(request: Request) {
            seen.search = new URL(request.url).search;
            return new Response('{"vessels":[]}', { status: 200 });
          },
        }),
      },
    };

    // An RPC name the supply-chain service does not define: the gateway
    // answers without touching the network, which is all this test needs.
    await realHandleDomainRpc(
      new Request('https://www.worldmonitor.app/api/supply-chain/v1/no-such-rpc'),
      env as never,
    );

    expect(setRelayFetch).toHaveBeenCalledTimes(1);
    const res = await relayFetch('https://www.worldmonitor.app/ais/snapshot?candidates=false', {});
    expect(await res.text()).toBe('{"vessels":[]}');
    expect(seen.search).toBe('?candidates=false');
  });
});
