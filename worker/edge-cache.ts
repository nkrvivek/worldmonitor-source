/**
 * The edge cache the CDN used to be.
 *
 * On Vercel a shared cache sat in front of the function and honored the
 * `s-maxage` the handlers emit. Here the Worker answers first
 * (`run_worker_first: true`, wrangler.jsonc) and a Worker-generated response
 * never enters Cloudflare's cache on its own, so those directives bought
 * nothing: measured 2026-08-06, the public weather URL came back with no
 * `cf-cache-status` at all across five probes, meaning every anonymous read
 * recomputed from Redis.
 *
 * What may be stored is decided by the RESPONSE, the same way a CDN decides
 * it. That is not a shortcut around auth: the handlers already answer
 * `no-store` for anything credential-dependent (api/bootstrap.js's
 * isSharedCacheableBootstrapKind, server/gateway.ts's cache policy), and the
 * URLs marked `&public=1` are documented as caller-invariant — a cache hit
 * precedes handler auth, so a credential-dependent answer at one of those
 * URLs could never be honored anyway.
 */

/** Names the layer that answered, so a probe can tell a hit from a recompute. */
export const EDGE_CACHE_STATUS_HEADER = 'x-wm-edge-cache';

export interface EdgeCacheStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Only what ExecutionContext.waitUntil gives us — the tests pass a stub. */
interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

function directives(response: Response): string {
  // A CDN reads CDN-Cache-Control in preference to Cache-Control, which is how
  // a handler tells the shared cache and the browser different things.
  return (
    response.headers.get('cdn-cache-control') ||
    response.headers.get('cache-control') ||
    ''
  ).toLowerCase();
}

function sharedMaxAgeSeconds(value: string): number {
  const match = /s-maxage\s*=\s*(\d+)/.exec(value);
  return match ? Number(match[1]) : 0;
}

/**
 * Cloudflare's Cache API does not vary a stored entry on arbitrary request
 * headers. A `vary: Origin` response carries a per-caller
 * access-control-allow-origin, so storing one would hand the first caller's
 * CORS answer to every later origin. Accept-Encoding is the exception the
 * platform handles itself.
 */
function variesOnlyOnEncoding(response: Response): boolean {
  const vary = response.headers.get('vary');
  if (!vary) return true;
  return vary
    .split(',')
    .map(part => part.trim().toLowerCase())
    .every(part => part === 'accept-encoding');
}

export function isEdgeCacheableRequest(request: Request): boolean {
  if (request.method !== 'GET') return false;
  // A range request wants a slice of a body this layer stores whole. Let it
  // through untouched rather than answering the wrong bytes.
  if (request.headers.has('range')) return false;
  return true;
}

export function isEdgeCacheableResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  if (response.headers.has('set-cookie')) return false;
  if (!variesOnlyOnEncoding(response)) return false;

  const value = directives(response);
  if (value.includes('no-store') || value.includes('private')) return false;
  if (!value.includes('public')) return false;
  return sharedMaxAgeSeconds(value) > 0;
}

function withStatus(response: Response, status: 'HIT' | 'MISS'): Response {
  const headers = new Headers(response.headers);
  headers.set(EDGE_CACHE_STATUS_HEADER, status);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The stored entry is keyed on the URL alone. Building the key request bare
 * keeps a stray request header out of the key, and keeps what gets stored
 * readable from the URL.
 */
function cacheKey(request: Request): Request {
  return new Request(request.url, { method: 'GET' });
}

/**
 * `caches.default` in the Workers runtime, null anywhere else. The plain-Node
 * suites in tests/worker have no Cache API, and a missing store means every
 * request goes straight to the handler.
 */
export function defaultEdgeCacheStore(): EdgeCacheStore | null {
  const api = (globalThis as { caches?: { default?: EdgeCacheStore } }).caches;
  return api?.default ?? null;
}

export async function withEdgeCache(
  request: Request,
  ctx: WaitUntilContext | null | undefined,
  store: EdgeCacheStore | null | undefined,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (!store || !isEdgeCacheableRequest(request)) return handler();

  const key = cacheKey(request);
  try {
    const hit = await store.match(key);
    if (hit) return withStatus(hit, 'HIT');
  } catch {
    // A cache that cannot be read is a cache miss, never a failed request.
  }

  const response = await handler();
  if (!isEdgeCacheableResponse(response)) return response;

  // The clone goes to the store and the original to the caller. The other way
  // round, a slow reader would hold the response stream open past the request.
  const toStore = response.clone();
  const write = store.put(key, toStore).catch(() => {
    // Same reasoning as the read: a full or unavailable cache must not turn a
    // good response into an error.
  });
  if (ctx) ctx.waitUntil(write);

  return withStatus(response, 'MISS');
}
