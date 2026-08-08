import { afterEach, describe, expect, test, vi } from 'vitest';

import { relayFetchViaDurableObject } from '../../worker/routes/maritime';

const SELF = 'https://worldmonitor.sibt.ai';

describe('relayFetchViaDurableObject', () => {
  // The bug this guards: WS_RELAY_URL names this Worker's own hostname, and a
  // Worker fetching its own hostname times out instead of re-entering. In
  // production that read as an empty ocean -- HTTP 522 from the relay path
  // while the Durable Object behind it held 8,000 vessels, 2026-08-04.
  function envWithRelay(seen: { search: string | null }): Parameters<typeof relayFetchViaDurableObject>[0] {
    return {
      AIS_RELAY: {
        idFromName: (name: string) => name,
        get: () => ({
          async fetch(request: Request) {
            seen.search = new URL(request.url).search;
            return new Response('{"disruptions":[],"density":[]}', { status: 200 });
          },
        }),
      },
    };
  }

  const originalFetch = global.fetch;
  const originalRelayUrl = process.env.WS_RELAY_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalRelayUrl === undefined) delete process.env.WS_RELAY_URL;
    else process.env.WS_RELAY_URL = originalRelayUrl;
  });

  function stubNetwork() {
    global.fetch = vi.fn(async () => new Response('network', { status: 200 })) as typeof fetch;
    return global.fetch as unknown as ReturnType<typeof vi.fn>;
  }

  test('sends the relay path to the Durable Object, not over the network', async () => {
    process.env.WS_RELAY_URL = SELF;
    const seen = { search: null as string | null };
    stubNetwork();

    const res = await relayFetchViaDurableObject(envWithRelay(seen), SELF)(
      `${SELF}/ais/snapshot?candidates=false`,
      {},
    );

    expect(await res.text()).toBe('{"disruptions":[],"density":[]}');
    expect(seen.search).toBe('?candidates=false');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // The other half of the same bug. /telegram, /opensky, /rss and the rest of
  // the old Node relay's paths are not ported, so a network fetch for one of
  // them reaches this Worker's own hostname and burns its whole timeout before
  // the handler gets the empty result it was always going to get.
  test('answers a relay path this Worker does not serve without leaving the isolate', async () => {
    process.env.WS_RELAY_URL = SELF;
    const seen = { search: null as string | null };
    stubNetwork();

    const res = await relayFetchViaDurableObject(envWithRelay(seen), SELF)(`${SELF}/telegram`, {});

    expect(res.status).toBe(404);
    expect(seen.search).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('leaves a URL that is not the relay on the network', async () => {
    process.env.WS_RELAY_URL = SELF;
    stubNetwork();

    const res = await relayFetchViaDurableObject(envWithRelay({ search: null }), SELF)(
      'https://opensky-network.org/api/states/all',
      {},
    );

    expect(await res.text()).toBe('network');
  });

  // Point WS_RELAY_URL at a relay that is somebody else and nothing here
  // applies: every path goes out over the network, including the ones this
  // Worker would have answered 404.
  test('leaves every path on the network when the relay is not this Worker', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    const seen = { search: null as string | null };
    stubNetwork();

    const fetcher = relayFetchViaDurableObject(envWithRelay(seen), SELF);
    expect(await (await fetcher('https://relay.example.com/telegram', {})).text()).toBe('network');
    expect(await (await fetcher('https://relay.example.com/ais/snapshot', {})).text()).toBe('network');
    expect(seen.search).toBeNull();
  });
});
