import { afterEach, describe, expect, test, vi } from 'vitest';

import { fetchWithTimeout, setRelayFetch } from '../../api/_relay.js';
import { relayFetchViaDurableObject } from '../../worker/routes/maritime';

const SELF = 'https://worldmonitor.sibt.ai';

/**
 * api/_relay.js is a second relay layer, parallel to server/_shared/relay.ts.
 * /api/opensky, /api/telegram-feed, /api/oref-alerts, /api/polymarket and
 * /api/rss-proxy all reach the relay through it, and it had its own bare
 * fetch() -- so pointing the server layer at the Durable Object left these
 * five still fetching this Worker's own hostname. Measured after the server-
 * side fix: /api/opensky and /api/telegram-feed still answered 522.
 */
describe('api/_relay.js relay override', () => {
  const originalFetch = global.fetch;
  const originalRelayUrl = process.env.WS_RELAY_URL;

  afterEach(() => {
    setRelayFetch(null);
    global.fetch = originalFetch;
    if (originalRelayUrl === undefined) delete process.env.WS_RELAY_URL;
    else process.env.WS_RELAY_URL = originalRelayUrl;
  });

  function stubNetwork() {
    global.fetch = vi.fn(async () => new Response('network', { status: 200 })) as typeof fetch;
    return global.fetch as unknown as ReturnType<typeof vi.fn>;
  }

  function envWithRelay(seen: { search: string | null }) {
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
    } as Parameters<typeof relayFetchViaDurableObject>[0];
  }

  test('goes over the network until an override is installed', async () => {
    const netFetch = stubNetwork();

    const res = await fetchWithTimeout('https://opensky-network.org/api/states/all', {});

    expect(await res.text()).toBe('network');
    expect(netFetch).toHaveBeenCalled();
  });

  test('sends a relay path this Worker serves to the Durable Object', async () => {
    process.env.WS_RELAY_URL = SELF;
    const seen = { search: null as string | null };
    stubNetwork();
    setRelayFetch(relayFetchViaDurableObject(envWithRelay(seen), SELF));

    const res = await fetchWithTimeout(`${SELF}/ais/snapshot?candidates=false`, {});

    expect(await res.text()).toBe('{"disruptions":[],"density":[]}');
    expect(seen.search).toBe('?candidates=false');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // The path that produced the live 522: /opensky is not ported, so the old
  // bare fetch reached this Worker's own hostname and could only fail.
  test('answers an unported relay path without leaving the isolate', async () => {
    process.env.WS_RELAY_URL = SELF;
    stubNetwork();
    setRelayFetch(relayFetchViaDurableObject(envWithRelay({ search: null }), SELF));

    const res = await fetchWithTimeout(`${SELF}/opensky`, {});

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // rss-proxy.js fetches arbitrary feed URLs through this same helper. Those
  // must still go out over the network.
  test('leaves a URL that is not the relay on the network', async () => {
    process.env.WS_RELAY_URL = SELF;
    stubNetwork();
    setRelayFetch(relayFetchViaDurableObject(envWithRelay({ search: null }), SELF));

    const res = await fetchWithTimeout('https://example.com/feed.xml', {});

    expect(await res.text()).toBe('network');
  });

  test('still applies its timeout to an overridden call', async () => {
    process.env.WS_RELAY_URL = SELF;
    stubNetwork();
    setRelayFetch(async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
      }),
    );

    await expect(fetchWithTimeout(`${SELF}/opensky`, {}, 10)).rejects.toThrow('AbortError');
  });
});
