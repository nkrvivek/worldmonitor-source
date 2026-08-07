/**
 * The worldmonitor front-end Worker.
 *
 * Walks the phases vercel.json implies, in Vercel's order:
 *   redirect -> static asset -> rewrite -> 404
 * then applies the header table to whatever came back.
 *
 * The static-asset step sits BEFORE rewrites on purpose. vite renames the
 * index.html output to dashboard.html (vite.config.ts:290-307), so nothing is
 * served at `/` from the filesystem and the `/` rewrites are what answer it.
 * Move the asset lookup after the rewrites and `/` serves the SPA on every
 * host instead of the pro welcome page.
 */
import { headersFor, matchRedirect, matchRewrite } from './routing/resolve';
import { defaultEdgeCacheStore, withEdgeCache } from './edge-cache';
import {
  AIS_SNAPSHOT_PATH,
  AIS_TRANSITS_PATH,
  handleAisSnapshot,
  handleAisTransits,
} from './routes/ais-snapshot';
import { COUNTER_READ_PATH, handleCounterDailyRead } from './routes/counter-read';
import { isDomainPathHandledInWorker, handleDomainRpc } from './routes/domains';
import { setRelayFetch } from '../server/_shared/relay';
import { setRelayFetch as setPlainApiRelayFetch } from '../api/_relay.js';
import { relayFetchViaDurableObject } from './routes/maritime';
import { isBootstrapPath, handleBootstrap } from './routes/bootstrap';
import { WM_SESSION_PATH, handleWmSession } from './routes/wm-session';
import { isPaymentPathHandledInWorker, handlePaymentRpc } from './routes/payments';
import { isAnalyticsPathHandledInWorker, handleAnalyticsCollect } from './routes/analytics-collect';
import { isMcpPathHandledInWorker, handleMcpRpc } from './routes/mcp';
import { setStaticAssetFetch } from '../api/mcp/handler';
import { isOauthPathHandledInWorker, handleOauth } from './routes/oauth';
import { isAgentPathHandledInWorker, handleAgent } from './routes/agent';
import {
  isSocialPreviewPathHandledInWorker,
  handleSocialPreview,
} from './routes/social-preview';
import { isHealthPath, handleHealth } from './routes/health';
import { isPlainApiPathHandledInWorker, handlePlainApi } from './routes/plain-api';
// @ts-expect-error — JS module, no declaration file
import { setRateLimitEnv } from '../api/_rate-limit.js';

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  UPSTREAM_API_ORIGIN: string;
  /**
   * Optional here even though wrangler.jsonc's durable_objects binding always
   * provides it in production: this keeps the pre-existing plain-Node tests
   * in tests/worker/index.test.mts (which build Env objects that never
   * exercise the counter route) from needing to change just to satisfy a
   * field they never touch. worker/routes/counter-read.ts treats a missing
   * COUNTER the same as a missing COUNTER_INTERNAL_HMAC_SECRET: fail closed
   * to the same bare 401, never fall open.
   */
  COUNTER?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  /** Worker secret binding (`wrangler secret put COUNTER_INTERNAL_HMAC_SECRET`).
   *  Optional because the binding is absent until someone runs that command --
   *  worker/routes/counter-read.ts treats absence as a plain 401, never a crash. */
  COUNTER_INTERNAL_HMAC_SECRET?: string;
  /**
   * Optional for the same reason as COUNTER: the plain-Node Env literals in
   * tests/worker/index.test.mts never reach the relay route, and
   * worker/routes/ais-snapshot.ts already answers a missing binding with a
   * 500 rather than throwing.
   */
  AIS_RELAY?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  /** Worker secret binding (`wrangler secret put RELAY_SHARED_SECRET`).
   *  Absent until someone runs that command, and absence means every relay
   *  request gets a 401 -- fail closed, never open. */
  RELAY_SHARED_SECRET?: string;
  /** Name of the header carrying the secret. Set in wrangler.jsonc's vars,
   *  not a secret itself; ais/auth.ts falls back to 'x-relay-key'. */
  RELAY_AUTH_HEADER?: string;
  /**
   * Analytics Engine dataset behind /api/send. Optional for the same reason as
   * COUNTER above -- the plain-Node Env literals in tests/worker never reach
   * the collector, and worker/routes/analytics-collect.ts skips the write when
   * the binding is absent rather than throwing.
   */
  WM_ANALYTICS?: {
    writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
  };
}

/**
 * Per the Fetch spec, a GET or HEAD request can never carry a body -- only
 * these two methods can safely be handed to env.ASSETS.fetch(request) ahead
 * of the rewrite check. Every other method (POST, PUT, PATCH, ...) skips the
 * asset probe entirely and goes straight to matchRewrite.
 *
 * This isn't just a shortcut: a static asset was never going to answer a
 * POST anyway (Vercel doesn't serve files from the filesystem for POST
 * either), so skipping loses nothing. What it buys is correctness --
 * env.ASSETS.fetch(request) reads/locks the request's body stream, and a
 * body can only be read once. Every rewrite the /api/* and off-origin proxy
 * branches exist for (/mcp, /a2a, /ask, /oauth/token, ...) is a POST with a
 * body the proxy still needs to forward; probing the asset first would
 * disturb that body and the later `new Request(target, request)` in
 * proxy() would throw. Cloning the request instead (`request.clone()`)
 * would also avoid the crash, but buffers the whole body in memory on every
 * single request just to answer a check that a body-carrying request could
 * never win. Skipping the probe costs nothing extra and is closer to what
 * Vercel actually does.
 */
const ASSET_SAFE_METHODS = new Set(['GET', 'HEAD']);

function withRoutingHeaders(response: Response, pathname: string): Response {
  const merged = new Headers(response.headers);
  headersFor(pathname).forEach((value, key) => merged.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

/**
 * vercel.json sets neither `cleanUrls` nor `trailingSlash`, so Vercel's
 * static host falls back to its own default: a directory with an
 * `index.html` serves it, and a bare request missing the trailing slash gets
 * a 308 redirect to add one. `html_handling: "none"` (wrangler.jsonc) turns
 * both of those off completely -- it has to stay "none" because a wider
 * value would also swallow the 404 the rewrite chain in the fetch handler
 * below depends on for every non-directory miss (see the comment on
 * `not_found_handling` in wrangler.jsonc) -- so the directory-index default
 * is reimplemented here instead, confirmed against production for
 * /countries/afghanistan and /chokepoints/strait-of-hormuz (parity harness,
 * scripts/routing-parity.mjs).
 *
 * Only called on a GET/HEAD asset miss, so there is no request body to
 * disturb by re-probing ASSETS.fetch with a second, index.html-suffixed URL.
 */
async function resolveDirectoryIndex(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;
  // Already the literal file -- appending "/index.html" again would build a
  // nonsensical double-suffixed path instead of retrying the same miss.
  if (pathname.endsWith('/index.html')) return null;

  const indexPath = pathname.endsWith('/') ? `${pathname}index.html` : `${pathname}/index.html`;
  const indexUrl = new URL(indexPath, url);
  indexUrl.search = '';
  const indexAsset = await env.ASSETS.fetch(new Request(indexUrl.toString(), request));
  if (indexAsset.status === 404) return null;

  // Request already had the trailing slash: serve the index content
  // directly, the same way Vercel does for a directory request that's
  // already correctly formed.
  if (pathname.endsWith('/')) {
    return withRoutingHeaders(indexAsset, pathname);
  }
  // Bare directory path: match Vercel's redirect rather than serving content
  // at a URL production would never emit, so a client that follows the
  // Location header lands on the exact path production would send it to.
  return new Response(null, {
    status: 308,
    headers: { Location: `${pathname}/${url.search}` },
  });
}

async function proxy(request: Request, target: string): Promise<Response> {
  const outbound = new Request(target, request);
  outbound.headers.set('X-Forwarded-Host', new URL(request.url).host);
  try {
    return await fetch(outbound);
  } catch {
    // Upstream (Vercel origin or Mintlify) unreachable or timed out. Return a
    // real response instead of letting the throw surface as Cloudflare's
    // generic error page.
    return new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
  }
}

async function resolveDestination(
  request: Request,
  env: Env,
  destination: string,
): Promise<Response> {
  // No rewrite in the config points off-origin today — the last one did, to
  // Mintlify, until we started building the docs ourselves. The branch stays
  // because the config still accepts an absolute destination, and without it
  // one would be read as a path and 404 against the assets.
  if (destination.startsWith('http://') || destination.startsWith('https://')) {
    return proxy(request, destination);
  }
  if (destination.startsWith('/api/')) {
    // destination already carries the incoming query string — matchRewrite's
    // firstMatch (routing/resolve.ts) merges it via mergeQueryString before
    // this function ever sees the destination — so a plain relative resolve
    // against the upstream origin is enough; no need to copy request.url's
    // search across separately.
    const target = new URL(destination, env.UPSTREAM_API_ORIGIN);
    return proxy(request, target.toString());
  }
  // Reached whenever a rewrite resolves to an asset-relative destination.
  // For a body-carrying request (POST etc.) this is the only ASSETS.fetch()
  // call, since the probe in the handler below skips those methods
  // entirely. For GET/HEAD it can be the SECOND call: the probe already ran
  // once and returned 404, and the SPA catch-all rewrite lands back here.
  // That repeat call is harmless, not because the body was never read
  // before, but because GET/HEAD requests never carry a body (Fetch spec)
  // -- there is nothing to lock or re-read either time.
  const assetUrl = new URL(destination, request.url);
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

export default {
  /**
   * Every GET goes through the edge cache first. Nothing about routing changes:
   * withEdgeCache stores only what the handler marked public with an s-maxage,
   * which is what a CDN would have stored, and passes everything else straight
   * through. See worker/edge-cache.ts for why the Worker has to hold this
   * itself here.
   */
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    return withEdgeCache(request, ctx, defaultEdgeCacheStore(), () =>
      route(request, env, ctx),
    );
  },
};

async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  // Give api/_rate-limit.js's checkRateLimit (reached via WM_SESSION_PATH
  // below -> handleWmSession -> api/wm-session.js) the COUNTER Durable
  // Object binding so the wms_ session minter rate-limits through CounterDO
  // instead of failing closed for lack of Upstash config. Fix round 1,
  // Task 4: cheap module-level assignment, safe on every request -- env is
  // stable for this Worker's whole deployment lifetime.
  setRateLimitEnv(env.COUNTER ? { COUNTER: env.COUNTER } : null);

  const url = new URL(request.url);

  // Same shape, same reason: WS_RELAY_URL names this Worker, so a relay call
  // that goes out over the network reaches its own hostname and times out
  // instead of re-entering. This sends /ais/snapshot to the Durable Object
  // and answers the unported relay paths 404 on the spot. It sits here
  // rather than in the domain branch alone because /api/bootstrap reaches
  // relay-backed handlers too.
  //
  // Both relay layers get it. api/_relay.js is a separate copy of the same
  // helper, and /api/opensky, /api/telegram-feed, /api/oref-alerts,
  // /api/polymarket and /api/rss-proxy reach the relay only through that
  // one -- they kept answering 522 while the server/ layer was already fixed.
  const relayViaDo = relayFetchViaDurableObject(env, url.origin);
  setRelayFetch(relayViaDo);
  setPlainApiRelayFetch(relayViaDo);

  // Same shape, different consumer: the MCP handler serves /mcp and
  // /.well-known/mcp from two static documents it used to read by fetching
  // its own hostname. A Worker cannot fetch the host it is serving, so every
  // crawler GET fell through to the handler's 302 fallback while both files
  // answered 200 at their own URLs. Read them off the assets binding instead.
  setStaticAssetFetch(async (path) => {
    const asset = await env.ASSETS.fetch(new Request(new URL(path, url.origin).toString()));
    return asset.ok ? await asset.text() : null;
  });

  // Matched before the redirect table, the ASSETS probe, and the rewrite
  // chain (task-6a brief, ambiguity resolution 1) so nothing below this
  // line can ever shadow it -- an internal route Convex calls directly,
  // never a browser navigation a redirect/rewrite rule would plausibly
  // target.
  if (url.pathname === COUNTER_READ_PATH) {
    return handleCounterDailyRead(request, env);
  }

  // Same placement, same reasoning: an internal route the front end calls
  // with a shared secret, never a browser navigation the redirect or
  // rewrite tables should be able to shadow.
  if (url.pathname === AIS_SNAPSHOT_PATH) {
    return handleAisSnapshot(request, env);
  }

  // Same door, same secret. Read by the seed container that writes
  // supply_chain:transit-summaries:v1 -- see docs/architecture/sibt-wiring.md.
  if (url.pathname === AIS_TRANSITS_PATH) {
    return handleAisTransits(request, env);
  }

  // Matched before the redirect table, the ASSETS probe, and the rewrite
  // chain, same reasoning as COUNTER_READ_PATH above: an in-Worker gateway
  // route is never something a redirect/rewrite rule should plausibly
  // shadow. One branch covers every domain -- see worker/routes/domains.ts.
  if (isDomainPathHandledInWorker(url.pathname)) {
    return handleDomainRpc(request, env, ctx);
  }

  // Same placement and same reasoning as the two gateways above. This is the
  // single call the front end makes to fill the map and the panels, so while
  // it fell through to the UPSTREAM_API_ORIGIN proxy the site loaded and
  // showed nothing.
  if (isBootstrapPath(url.pathname)) {
    return handleBootstrap(request, ctx);
  }

  // Anonymous wms_ session minter (Task 4). The market routes above all
  // require a wms_ session cookie (server/gateway.ts's validateApiKey
  // path); this is the only endpoint that mints one, so it has to be
  // routed before the redirect/rewrite chain the same way the market
  // gateway is.
  if (url.pathname === WM_SESSION_PATH) {
    return handleWmSession(request, ctx);
  }

  // Same placement, same reasoning. Four endpoints: the price list the
  // pricing page reads, the two checkout gateways, and the entitlement
  // probe /pro calls on every load. All four fell through to the
  // UPSTREAM_API_ORIGIN proxy and 404'd, so nobody could see a price or
  // buy anything -- see worker/routes/payments.ts.
  if (isPaymentPathHandledInWorker(url.pathname)) {
    return handlePaymentRpc(request, ctx);
  }

  // The dashboard's own event collector. Same placement, same reasoning: a
  // POST-only endpoint the front end calls directly, never a navigation the
  // redirect or rewrite tables should shadow. It replaces the hosted Umami
  // install the upstream project runs -- see worker/routes/analytics-collect.ts.
  if (isAnalyticsPathHandledInWorker(url.pathname)) {
    return handleAnalyticsCollect(request, env);
  }

  // The MCP front door and the discovery documents that point at it. Same
  // placement, same reasoning: JSON-RPC over POST and .well-known metadata,
  // never navigations a redirect or rewrite rule should shadow. Every one of
  // these fell through to the UPSTREAM_API_ORIGIN proxy and returned 530, so
  // no client could reach our tools -- see worker/routes/mcp.ts.
  if (isMcpPathHandledInWorker(url.pathname)) {
    return handleMcpRpc(request, ctx);
  }

  // The grant flow the discovery documents point a client at: register,
  // authorize, token, plus the Pro bridge the /mcp-grant page calls. Without
  // these the client reads our metadata, walks to /oauth/register, and gets a
  // 530 -- see worker/routes/oauth.ts.
  if (isOauthPathHandledInWorker(url.pathname)) {
    return handleOauth(request);
  }

  // The agent front doors the agent card and llms.txt advertise: the A2A
  // JSON-RPC service and the NLWeb /ask endpoint -- see worker/routes/agent.ts.
  if (isAgentPathHandledInWorker(url.pathname)) {
    return handleAgent(request);
  }

  // The share card a crawler fetches, and the SVG it embeds -- see
  // worker/routes/social-preview.ts.
  if (isSocialPreviewPathHandledInWorker(url.pathname)) {
    return handleSocialPreview(request);
  }

  // The status endpoint this site advertises to the world -- see
  // worker/routes/health.ts. Matched after the domain gateways above so the
  // sebuf service on /api/health/v1/ keeps its prefix.
  if (isHealthPath(url.pathname)) {
    return handleHealth(request, ctx);
  }

  // The first-party /api endpoints that never became sebuf RPCs. Matched
  // after every gateway above so a domain prefix always wins, and before the
  // redirect/rewrite chain for the same reason the gateways are -- these are
  // fetch targets, not navigations. See worker/routes/plain-api.ts.
  if (isPlainApiPathHandledInWorker(url.pathname)) {
    return handlePlainApi(request, ctx);
  }

  const parts = {
    host: url.host,
    pathname: url.pathname,
    search: url.searchParams,
  };

  const redirect = matchRedirect(parts);
  if (redirect) {
    return new Response(null, {
      status: redirect.status,
      headers: { Location: redirect.location },
    });
  }

  const asset = ASSET_SAFE_METHODS.has(request.method)
    ? await env.ASSETS.fetch(request)
    : null;
  if (asset && asset.status !== 404) {
    return withRoutingHeaders(asset, url.pathname);
  }

  const rewrite = matchRewrite(parts);
  if (rewrite) {
    const response = await resolveDestination(request, env, rewrite.destination);
    return withRoutingHeaders(response, url.pathname);
  }

  // Neither an exact asset nor an explicit rewrite matched. An explicit
  // rewrite (like /pro -> /pro/index.html) always wins over the implicit
  // directory-index default below it -- Vercel serves /pro at 200 with no
  // redirect precisely because that rule exists, and trying the implicit
  // default first would 308 a path Vercel never redirects. Only once both
  // of those come up empty is it safe to try Vercel's implicit default.
  if (ASSET_SAFE_METHODS.has(request.method)) {
    const directoryIndex = await resolveDirectoryIndex(request, env, url);
    if (directoryIndex) {
      return directoryIndex;
    }
  }

  return withRoutingHeaders(asset ?? new Response(null, { status: 404 }), url.pathname);
}
