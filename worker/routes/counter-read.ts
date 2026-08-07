/**
 * `POST /internal/counter/daily-read` — lets Convex (off-platform) read a
 * per-user daily rate-limit counter stored in `CounterDO`. A Durable Object
 * is otherwise reachable only through a Worker binding, and Convex runs on
 * its own infrastructure, so it needs plain HTTP (task-6a brief).
 *
 * This route exposes per-user API usage counts over the public internet.
 * Every check below is load-bearing (brief's own words) -- do not remove one
 * to simplify this file.
 */
import {
  verifyInternalMcpRequest,
  INTERNAL_MCP_REPLAY_CACHE_TTL_SECONDS,
} from '../../server/_shared/mcp-internal-hmac';
import { callCounter } from '../counters/protocol';
import { dailyMeterShardName } from '../counters/daily-meter';
import type { Env } from '../index';

/** The one path this module answers. Matched in worker/index.ts before the
 *  ASSETS probe, the redirect table, and the rewrite chain, so nothing else
 *  in that fetch handler can shadow it. */
export const COUNTER_READ_PATH = '/internal/counter/daily-read';

/**
 * Namespaces Convex may read through this route. The request body names the
 * namespace; without an allowlist, a holder of the shared HMAC secret could
 * read any counter the DO stores, including the MCP Pro quota
 * (`mcp:pro-usage`, api/mcp/quota.ts). Module constant per requirement 4 --
 * the value is never typed twice.
 */
const ALLOWED_NAMESPACES: ReadonlySet<string> = new Set(['rl:apikey:day']);

/**
 * One dedicated CounterDO instance for this route's OWN bookkeeping -- the
 * nonce replay cache and the route's self-rate-limit both live here, kept
 * deliberately apart from any per-user daily-meter instance so a single
 * high-traffic target user can never crowd out the replay cache (or vice
 * versa). Both ops this instance serves ('nonce-check' for the nonce cache,
 * keyed under REPLAY_NAMESPACE, and 'sliding' for the throttle, keyed under
 * ROUTE_SHARD_NAME) write to disjoint storage-key prefixes inside the DO
 * (worker/counters/counter-do.ts: 'nonce-check' keys are
 * `${namespace}:${nonce}`, 'sliding' keys are `w:${key}`), so sharing one
 * instance for both is safe.
 */
const ROUTE_SHARD_NAME = 'internal:counter-daily-read:route';

/**
 * Nonce replay-cache namespace inside the shared route shard (brief's own
 * snippet, requirement 3). Backed by the dedicated 'nonce-check' op
 * (worker/counters/protocol.ts), NOT 'daily' -- 'daily' routes through
 * reserveDaily, whose storage key is calendar-day-partitioned
 * (worker/counters/daily-meter.ts's dailyKey()), and a nonce cache has
 * nothing to do with calendar days: a captured signed request replayed
 * across a UTC-midnight boundary would compute a different day's key and
 * slip past the guard, inside the HMAC's own timestamp tolerance. See
 * `nonce-check`'s doc comment in protocol.ts for the full story (this was
 * a shipped defect, fixed after whole-branch review -- do not revert to
 * reusing 'daily' here).
 */
const REPLAY_NAMESPACE = 'nonce:counter-read';

/** Route-level self-throttle (requirement 7): 60/min is ample for the one
 *  real caller (an hourly cron) and keeps a leaked secret from enumerating
 *  users at speed. Exported so the test can drive exactly this many requests
 *  instead of a duplicated magic number. */
export const COUNTER_READ_ROUTE_RATE_LIMIT = 60;
const COUNTER_READ_ROUTE_WINDOW_MS = 60_000;

/**
 * Duck-typed Durable Object stub, matching the structural type callCounter
 * (worker/counters/protocol.ts) accepts. Declared locally rather than
 * imported, following the convention already established in
 * server/_shared/rate-limit.ts and api/mcp/quota.ts: this file stays
 * plain-Node-loadable (no `cloudflare:workers` import) for exactly the same
 * reason worker/index.ts must (worker/entry.ts's comment on why the Worker
 * and CounterDO are exported from separate files).
 */
interface CounterStub {
  fetch(request: Request): Promise<Response>;
}

function routeShard(counter: NonNullable<Env['COUNTER']>): CounterStub {
  return counter.get(counter.idFromName(ROUTE_SHARD_NAME));
}

/**
 * DO instance for the target user's real daily counter. The instance name
 * itself -- `dailyMeterShardName()` -- lives in worker/counters/daily-meter.
 * ts, next to `dailyKey()`, not here: this route is only one of its readers,
 * and Task 6b's writer (server/_shared/api-key-rate-limit.ts, does not exist
 * yet) needs to import the same function, which it cannot cleanly do from
 * under worker/routes/ (see that function's doc comment for the ASSUMPTION
 * this shard-naming scheme rests on, and what silently breaks if a future
 * writer picks a different one).
 */
function userShard(counter: NonNullable<Env['COUNTER']>, namespace: string, userId: string): CounterStub {
  return counter.get(counter.idFromName(dailyMeterShardName(namespace, userId)));
}

/** Requirement 5 -- every authentication failure collapses to this exact
 *  response: bare 401, no body, nothing that would let a caller distinguish
 *  which check it failed. This collapsing IS the correct error handling for
 *  this route, not a violation of "never swallow an error" -- the brief
 *  calls it out by name as "no error oracle." */
function unauthorized(): Response {
  return new Response(null, { status: 401 });
}

function badRequest(): Response {
  return new Response(null, { status: 400 });
}

interface CounterReadBody {
  namespace?: unknown;
}

export async function handleCounterDailyRead(request: Request, env: Env): Promise<Response> {
  // Requirement 6: POST only. Checked before anything else -- method is a
  // routing fact, not an authentication outcome, so it gets its own status
  // rather than folding into the 401 family.
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }

  // Ambiguity resolution 3: an absent secret is the same bare 401 as any
  // other auth failure -- never a throw, never a fall-open. A missing
  // COUNTER binding gets the same treatment: without it nothing below (the
  // replay guard, the rate limit, the read itself) can run at all, and the
  // safe direction is closed, not open. Captured into locals so TypeScript
  // narrows them once and every helper below takes the narrowed type
  // directly, rather than re-deriving the narrowing from `env.COUNTER` at
  // each call site.
  const secret = env.COUNTER_INTERNAL_HMAC_SECRET;
  const counter = env.COUNTER;
  if (!secret || !counter) return unauthorized();

  const verified = await verifyInternalMcpRequest(request, secret);
  if (!verified) return unauthorized();

  // Requirement 3: reject replays. verifyInternalMcpRequest binds the nonce
  // into the signature but keeps no memory of it -- that's this call's job.
  // 'nonce-check' keys storage on the nonce alone and expires purely off
  // INTERNAL_MCP_REPLAY_CACHE_TTL_SECONDS -- no calendar-day partitioning,
  // unlike 'daily' -- so a replay is still caught even when it lands on the
  // other side of a UTC-midnight boundary from the original request. A
  // storage failure (metered: false) is treated exactly like a real replay:
  // this call must never wave a possible replay through just because it
  // could not check.
  const seen = await callCounter(routeShard(counter), {
    op: 'nonce-check',
    namespace: REPLAY_NAMESPACE,
    nonce: verified.nonce,
    ttlSeconds: INTERNAL_MCP_REPLAY_CACHE_TTL_SECONDS,
  });
  if (seen.op !== 'nonce-check' || !seen.metered || seen.seen) return unauthorized();

  // verifyInternalMcpRequest clones the request to hash the body, so the
  // original stream is still fully readable here. Verify first, parse
  // second (the brief's own gotcha #1).
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest();
  }
  const namespace = (body as CounterReadBody | null)?.namespace;
  if (typeof namespace !== 'string' || !ALLOWED_NAMESPACES.has(namespace)) {
    return badRequest();
  }

  // Requirement 7: rate-limit the route itself, keyed on the route -- not on
  // the target userId, which would let a leaked secret walk the whole user
  // list at the limit per user instead of once total.
  const limited = await callCounter(routeShard(counter), {
    op: 'sliding',
    key: ROUTE_SHARD_NAME,
    limit: COUNTER_READ_ROUTE_RATE_LIMIT,
    windowMs: COUNTER_READ_ROUTE_WINDOW_MS,
  });
  if (limited.op !== 'sliding' || !limited.success) {
    return new Response(null, { status: 429 });
  }

  // The userId does NOT come from the body (requirement 4) -- it comes from
  // verified.userId, which arrived in the X-WM-MCP-User-Id header and is
  // folded into the signed payload by buildHmacPayload, so it is already
  // authenticated. The body carries only `{ namespace }`.
  const result = await callCounter(userShard(counter, namespace, verified.userId), {
    op: 'daily-read',
    namespace,
    userId: verified.userId,
  });
  if (result.op !== 'daily-read') {
    // Unreachable in practice: CounterDO.dispatch() switches on the same op
    // it was given, so a mismatched op here means the DO itself broke its
    // own contract. Not an auth failure, so it does not collapse into 401 --
    // surfacing it loudly is the correct error handling here, not swallowing
    // it as "just another 401."
    throw new Error(`counter DO returned op "${result.op}" for a daily-read request`);
  }

  // Requirement 8: return only { present, count }. No timing data, no key
  // names, no echo of the request.
  return new Response(JSON.stringify({ present: result.present, count: result.count }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
