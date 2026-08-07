import { describe, expect, test } from 'vitest';
import {
  EDGE_CACHE_STATUS_HEADER,
  isEdgeCacheableRequest,
  isEdgeCacheableResponse,
  withEdgeCache,
  type EdgeCacheStore,
} from '../../worker/edge-cache';

/**
 * The live sweep (tests/live-api-cache-auth-regression.test.mjs) asked the
 * public weather URL to become a shared-cache HIT and never got one: five
 * probes, `cf-cache-status` absent every time. It is not a stale rule. A
 * Worker-generated response never enters Cloudflare's edge cache on its own,
 * and `run_worker_first: true` (wrangler.jsonc) puts the Worker in front of
 * the cache on the way in as well. So every `s-maxage` the handlers emit was
 * decorative here: each public read recomputed from Redis on every request.
 *
 * This is the cache the CDN used to be. The rules below are a CDN's rules,
 * deliberately: what may be stored is decided by the RESPONSE, because the
 * handlers already answer no-store for anything credential-dependent.
 */

const URL_A = 'https://worldmonitor.sibt.ai/api/bootstrap?keys=weatherAlerts&public=1';

function publicResponse(extraHeaders: Record<string, string> = {}, status = 200): Response {
  return new Response('{"data":1}', {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, s-maxage=600, stale-while-revalidate=120',
      ...extraHeaders,
    },
  });
}

class MemoryStore implements EdgeCacheStore {
  readonly entries = new Map<string, Response>();
  puts = 0;

  async match(request: Request): Promise<Response | undefined> {
    const hit = this.entries.get(request.url);
    return hit ? hit.clone() : undefined;
  }

  async put(request: Request, response: Response): Promise<void> {
    this.puts += 1;
    this.entries.set(request.url, response);
  }
}

describe('what may be stored', () => {
  test('a GET marked public with s-maxage is storable', () => {
    expect(isEdgeCacheableRequest(new Request(URL_A))).toBe(true);
    expect(isEdgeCacheableResponse(publicResponse())).toBe(true);
  });

  test('CDN-Cache-Control wins over Cache-Control, the way a CDN reads them', () => {
    const response = new Response('{}', {
      headers: {
        'cache-control': 'no-store',
        'cdn-cache-control': 'public, s-maxage=600',
      },
    });
    expect(isEdgeCacheableResponse(response)).toBe(true);
  });

  test('no-store, private, and a missing s-maxage are all unstorable', () => {
    for (const value of ['no-store', 'private, s-maxage=600', 'public, max-age=60', 'public, s-maxage=0']) {
      const response = new Response('{}', { headers: { 'cache-control': value } });
      expect(isEdgeCacheableResponse(response), value).toBe(false);
    }
  });

  test('a non-200 is never stored, however it is marked', () => {
    expect(isEdgeCacheableResponse(publicResponse({}, 404))).toBe(false);
  });

  test('Set-Cookie makes a response unstorable', () => {
    expect(isEdgeCacheableResponse(publicResponse({ 'set-cookie': 'a=b' }))).toBe(false);
  });

  /**
   * Cloudflare's Cache API does not vary the stored entry on arbitrary request
   * headers. A `vary: Origin` response carries a per-caller
   * access-control-allow-origin, so storing one would hand the first caller's
   * CORS answer to every later origin. Accept-Encoding is the exception the
   * platform handles itself.
   */
  test('Vary on anything but Accept-Encoding makes a response unstorable', () => {
    expect(isEdgeCacheableResponse(publicResponse({ vary: 'Origin' }))).toBe(false);
    expect(isEdgeCacheableResponse(publicResponse({ vary: 'accept-encoding' }))).toBe(true);
  });

  test('only GET is storable', () => {
    expect(isEdgeCacheableRequest(new Request(URL_A, { method: 'POST' }))).toBe(false);
    expect(isEdgeCacheableRequest(new Request(URL_A, { method: 'HEAD' }))).toBe(false);
    expect(isEdgeCacheableRequest(new Request(URL_A, { headers: { range: 'bytes=0-1' } }))).toBe(false);
  });
});

describe('serving through the cache', () => {
  test('second request is served from the store and the handler runs once', async () => {
    const store = new MemoryStore();
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return publicResponse();
    };

    const first = await withEdgeCache(new Request(URL_A), null, store, handler);
    expect(first.headers.get(EDGE_CACHE_STATUS_HEADER)).toBe('MISS');
    expect(await first.text()).toBe('{"data":1}');

    const second = await withEdgeCache(new Request(URL_A), null, store, handler);
    expect(second.headers.get(EDGE_CACHE_STATUS_HEADER)).toBe('HIT');
    expect(await second.text()).toBe('{"data":1}');
    expect(calls).toBe(1);
  });

  test('an unstorable response is passed straight through and never stored', async () => {
    const store = new MemoryStore();
    const noStore = () =>
      Promise.resolve(new Response('{}', { headers: { 'cache-control': 'no-store' } }));

    const response = await withEdgeCache(new Request(URL_A), null, store, noStore);

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has(EDGE_CACHE_STATUS_HEADER)).toBe(false);
    expect(store.puts).toBe(0);
  });

  test('a POST never touches the store', async () => {
    const store = new MemoryStore();
    const response = await withEdgeCache(
      new Request(URL_A, { method: 'POST' }),
      null,
      store,
      async () => publicResponse(),
    );
    expect(response.headers.has(EDGE_CACHE_STATUS_HEADER)).toBe(false);
    expect(store.puts).toBe(0);
  });

  /**
   * The handler's response body can only be read once. If the write took the
   * original and handed the caller a clone, a slow reader would hold the
   * stream open past the request; taking the clone for the write is the way
   * round that is safe under waitUntil.
   */
  test('the body reaches the caller intact even while the write is pending', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    const store = new MemoryStore();

    const response = await withEdgeCache(new Request(URL_A), ctx, store, async () => publicResponse());

    expect(await response.text()).toBe('{"data":1}');
    await Promise.all(pending);
    expect(store.puts).toBe(1);
  });

  test('a store that throws never breaks the response', async () => {
    const broken: EdgeCacheStore = {
      match: async () => {
        throw new Error('cache unavailable');
      },
      put: async () => {
        throw new Error('cache unavailable');
      },
    };

    const response = await withEdgeCache(new Request(URL_A), null, broken, async () => publicResponse());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"data":1}');
  });

  test('no store at all means the handler answers directly', async () => {
    const response = await withEdgeCache(new Request(URL_A), null, null, async () => publicResponse());
    expect(response.status).toBe(200);
    expect(response.headers.has(EDGE_CACHE_STATUS_HEADER)).toBe(false);
  });
});
