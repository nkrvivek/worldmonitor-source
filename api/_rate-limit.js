import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';
import {
  durationToSeconds,
  limitWithFallback,
  resetRateLimitFallbackForTest,
} from './_rate-limit-fallback.js';
import {
  RATE_LIMIT_DEGRADED_HEADERS,
  getClientIp,
} from './_client-ip.js';
// worker/counters/protocol.ts is a plain-TS module with no runtime deps of
// its own (Web-standard Request/Response only), so a plain-JS importer here
// is safe under every host that loads this file. This file itself is never
// typechecked (no allowJs/checkJs in tsconfig.api.json), so no
// @ts-expect-error pragma is needed on this side — that convention applies
// to the .ts callers of this file's own .js exports, not the reverse.
//
// The `.ts` extension is load-bearing, not decoration. Bundler hosts (tsx for
// test:data, the Worker bundler, Vercel's edge bundler) resolve the
// extensionless specifier fine, but `npm run test:sidecar` runs plain
// `node --test` with no loader, and node resolves a specifier literally: it
// looked for a file named `protocol`, found none, and every test file that
// reaches this module through an import chain died at load with
// ERR_MODULE_NOT_FOUND (_rate-limit, rss-proxy, security/report, wm-session).
// Spelling the extension lets node's own type stripping (unflagged since
// 23.6; CI runs 24) load it, and every bundler host accepts it too. The file
// stays erasable-only — types plus one function, no enums or namespaces —
// which is what node's stripper requires.
import { callCounter } from '../worker/counters/protocol.ts';
export {
  RATE_LIMIT_DEGRADED_HEADERS,
  UNKNOWN_CLIENT_IP,
  getClientIp,
} from './_client-ip.js';

// @upstash/redis defaults to 5 retries with exponential backoff (~4.3s total)
// before surfacing an unreachable-Redis error. Under a test runner skip the
// retries, so fail-open / fail-closed tests that point
// UPSTASH_REDIS_REST_URL at a fake host degrade at once instead of stalling.
// Both runners are named here: the node runner sets NODE_TEST_CONTEXT, vitest
// sets VITEST. Only NODE_TEST_CONTEXT was checked until a vitest suite
// (tests/worker/wm-session-route.test.mts) burned the full backoff on a fake
// host and timed out on CI, where the fake hostname resolves slower than it
// does here. Production (both unset) keeps the resilient default. Mirrors
// REDIS_TEST_RETRY_OPTS in server/_shared/rate-limit.ts and PR #3963.
const REDIS_TEST_RETRY_OPTS = process.env.NODE_TEST_CONTEXT || process.env.VITEST
  ? { retry: false }
  : {};

const DEFAULT_RATE_LIMIT_SCOPE = 'global';
const DEFAULT_RATE_LIMIT = 600;
const DEFAULT_RATE_LIMIT_WINDOW = '60 s';

let ratelimits = new Map();

function getRateLimitPolicy(opts = {}) {
  return {
    scope: opts.scope ?? DEFAULT_RATE_LIMIT_SCOPE,
    limit: opts.limit ?? DEFAULT_RATE_LIMIT,
    window: opts.window ?? DEFAULT_RATE_LIMIT_WINDOW,
  };
}

function getRatelimit(policy) {
  const cacheKey = `${policy.scope}|${policy.limit}|${policy.window}`;
  const cached = ratelimits.get(cacheKey);
  if (cached) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const ratelimit = new Ratelimit({
    redis: new Redis({ url, token, ...REDIS_TEST_RETRY_OPTS }),
    limiter: Ratelimit.slidingWindow(policy.limit, policy.window),
    prefix: policy.scope === DEFAULT_RATE_LIMIT_SCOPE ? 'rl' : `rl:${policy.scope}`,
    analytics: false,
  });
  ratelimits.set(cacheKey, ratelimit);

  return ratelimit;
}

// Decide the Sentry level for a degraded-rate-limit capture. Upstash runtime
// transients — the Lua limiter script timing out under fan-out load
// (`ERR Error running script: execution timed out`), a dropped command, or a
// network/timeout blip — are absorbed by the fail-open / `failClosed`-503 path,
// so the user is unaffected. Capture those at `warning` so a sustained Redis
// outage still escalates by volume without a transient script-timeout drowning
// genuine error-level signal in the dashboard (WORLDMONITOR-RX; mirrors the
// SERVICE_UNAVAILABLE `level: 'warning'` precedent in api/user-prefs.ts). A
// `missing-config` stage is a real deploy misconfiguration and any novel error
// is unclassified — both stay at `error` so on-call still sees them.
// Mirrored verbatim in server/_shared/rate-limit.ts.
function rateLimitErrorLevel(stage, msg) {
  if (stage.includes('missing-config')) return 'error';
  if (/Error running script|execution timed out|Command failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network|timed out|socket hang up|Redis unavailable|Redis unreachable/i.test(msg)) {
    return 'warning';
  }
  return 'error';
}

function logRateLimitDegraded(stage, err, ctx) {
  const msg = err instanceof Error ? err.message : String(err);
  // Keep the prefix stable — server/_shared/rate-limit.ts emits the same
  // shape and operators grep across both surfaces.
  console.error(`[rate-limit] redis-error stage=${stage} msg=${msg}`);
  captureSilentError(err, {
    tags: { surface: 'api', component: 'rate-limit', stage },
    fingerprint: ['rate-limit', 'redis-error', stage],
    ctx,
    level: rateLimitErrorLevel(stage, msg),
  });
}

function rateLimitDegradedResponse(corsHeaders) {
  return jsonResponse(
    { error: 'Rate-limit service temporarily unavailable' },
    503,
    { ...RATE_LIMIT_DEGRADED_HEADERS, ...corsHeaders },
  );
}

// `reset` is a Unix epoch in MILLISECONDS (Upstash convention, and what
// CounterDO's `sliding` op also returns — worker/counters/counter-do.ts's
// `sliding()` derives it as `windowStart + windowMs`). The IETF RateLimit
// fields carry a delta-seconds reset (`t` / RateLimit-Reset), NOT an epoch,
// so derive the remaining-seconds view for them and for Retry-After. The
// legacy X-RateLimit-Reset stays epoch-ms unchanged. Shared by both the
// Upstash path and the CounterDO path below so the 429 shape a caller sees
// never depends on which backend served it. Mirrors
// server/_shared/rate-limit.ts's tooManyRequestsResponse.
function tooManyRequestsResponse(limit, reset, corsHeaders, windowSeconds) {
  const resetSeconds = Math.max(0, Math.ceil((reset - Date.now()) / 1000));
  return jsonResponse({ error: 'Too many requests' }, 429, {
    // IETF RateLimit fields (draft-ietf-httpapi-ratelimit-headers). The
    // combined RateLimit member references the "default" policy advertised
    // on every API response via vercel.json so an agent can self-throttle.
    'RateLimit-Policy': `"default";q=${limit};w=${windowSeconds}`,
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': '0',
    'RateLimit-Reset': String(resetSeconds),
    RateLimit: `"default";r=0;t=${resetSeconds}`,
    // Legacy X-RateLimit-* retained for back-compat (Reset is epoch-ms).
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(reset),
    'Retry-After': String(resetSeconds),
    ...corsHeaders,
  });
}

/**
 * Durable Object stub shape this file needs — the same minimal duck-typed
 * interface `callCounter` (worker/counters/protocol.ts) already accepts, so
 * this module never has to import `cloudflare:workers` or
 * `@cloudflare/workers-types` and can keep loading under every host that
 * reaches it today: tsx (test:data), Vercel's edge bundler (the six other
 * callers below), and the Worker bundler.
 *
 * @typedef {{ fetch(request: Request): Promise<Response> }} CounterStub
 * @typedef {{ COUNTER: { idFromName(name: string): unknown, get(id: unknown): CounterStub } }} RateLimitCounterEnv
 */

/** @type {RateLimitCounterEnv | null} */
let counterEnv = null;

/**
 * Lets a Cloudflare Worker fetch handler hand this module its COUNTER
 * Durable Object binding once, so checkRateLimit can move traffic onto
 * CounterDO instead of Upstash. Mirrors setRateLimitEnv in
 * server/_shared/rate-limit.ts — the two should read side by side.
 *
 * worker/index.ts is the only caller that sets this (its fetch handler holds
 * a real COUNTER binding — see wrangler.jsonc / worker-configuration.d.ts —
 * and routes /api/wm-session onto handleWmSession, which reaches this file
 * through api/wm-session.js's checkRateLimit call). The six other importers
 * of this module (api/oauth/authorize.js, api/oauth/register.js,
 * api/oauth/token.ts, api/security/report.js, api/_relay.js,
 * api/rss-proxy.js) run as Vercel Edge Functions, never inside
 * worker/index.ts's process, so they never call this setter and
 * getCounterStub() below stays null for them — their checkRateLimit calls
 * take the exact Upstash path they take today.
 *
 * @param {RateLimitCounterEnv | null} env
 */
export function setRateLimitEnv(env) {
  counterEnv = env;
}

/** @param {string} key @returns {CounterStub | null} */
function getCounterStub(key) {
  if (!counterEnv) return null;
  return counterEnv.COUNTER.get(counterEnv.COUNTER.idFromName(key));
}

// CounterDO-backed check, tried before the Upstash path in checkRateLimit.
// `policy` carries the same per-call scope/limit/window this file has always
// supported (unlike server/_shared/rate-limit.ts's checkRateLimit, which is
// only ever called with the fixed global 600/60s default) — a namespace
// mismatch here would let two callers with different scopes share one
// counter bucket.
async function checkRateLimitViaCounter(stub, ip, policy, corsHeaders, opts) {
  const windowSeconds = durationToSeconds(policy.window);
  const key = policy.scope === DEFAULT_RATE_LIMIT_SCOPE ? `rl:${ip}` : `rl:${policy.scope}:${ip}`;
  try {
    const result = await callCounter(stub, {
      op: 'sliding',
      key,
      limit: policy.limit,
      windowMs: windowSeconds * 1000,
    });
    if (result.op !== 'sliding') throw new Error(`counter DO returned unexpected op ${result.op}`);
    if (!result.success) {
      return tooManyRequestsResponse(result.limit, result.reset, corsHeaders, windowSeconds);
    }
    return null;
  } catch (err) {
    logRateLimitDegraded('checkRateLimit:counter-do', err, opts.ctx);
    if (opts.failClosed) return rateLimitDegradedResponse(corsHeaders);
    return null;
  }
}

/**
 * @param {Request} request
 * @param {Record<string, string>} corsHeaders
 * @param {{ failClosed?: boolean, ctx?: { waitUntil: (p: Promise<unknown>) => void }, scope?: string, limit?: number, window?: import('@upstash/ratelimit').Duration }} [opts]
 *   When `failClosed` is true and Redis is unavailable, return a 503 with
 *   the `X-RateLimit-Mode: degraded` marker instead of allowing the
 *   request through. Pass `true` for endpoints where the rate-limit IS
 *   the abuse defence (LLM, checkout). Default `false` keeps the
 *   availability-first posture for general traffic so a Redis blip
 *   doesn't black-hole the whole site. `ctx` is the Vercel handler
 *   context — passing it lets the Sentry envelope dispatch survive
 *   isolate teardown. Top-level Edge handlers may pass `scope`, `limit`,
 *   and `window` for explicit endpoint budgets while retaining the shared
 *   degraded/429 response semantics. (#3531)
 */
export async function checkRateLimit(request, corsHeaders, opts = {}) {
  const policy = getRateLimitPolicy(opts);
  const ip = getClientIp(request);

  const stubKey = policy.scope === DEFAULT_RATE_LIMIT_SCOPE ? `rl:${ip}` : `rl:${policy.scope}:${ip}`;
  const stub = getCounterStub(stubKey);
  if (stub) return checkRateLimitViaCounter(stub, ip, policy, corsHeaders, opts);

  const rl = getRatelimit(policy);
  if (!rl) {
    if (opts.failClosed) {
      logRateLimitDegraded('checkRateLimit:missing-config', new Error('Upstash Redis is not configured'), opts.ctx);
      return rateLimitDegradedResponse(corsHeaders);
    }
    return null;
  }

  try {
    const fallbackPrefix = policy.scope === DEFAULT_RATE_LIMIT_SCOPE ? 'rl:fw' : `rl:${policy.scope}:fw`;
    const { success, limit, reset } = await limitWithFallback(
      rl,
      ip,
      `${fallbackPrefix}:${ip}`,
      policy.limit,
      durationToSeconds(policy.window),
    );

    if (!success) {
      return tooManyRequestsResponse(limit, reset, corsHeaders, durationToSeconds(policy.window));
    }

    return null;
  } catch (err) {
    logRateLimitDegraded('checkRateLimit', err, opts.ctx);
    if (opts.failClosed) return rateLimitDegradedResponse(corsHeaders);
    return null;
  }
}

export function __resetRateLimitForTest() {
  ratelimits = new Map();
  resetRateLimitFallbackForTest();
  counterEnv = null;
}
