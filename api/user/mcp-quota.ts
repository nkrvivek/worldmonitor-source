/**
 * GET /api/user/mcp-quota
 *
 * Clerk-authenticated read-only endpoint that returns the caller's current
 * Pro MCP daily quota usage. Reads the SAME Redis key shape that U7 writes
 * via INCR-first reservation in `api/mcp.ts` (`mcp:pro-usage:<userId>:<YYYY-MM-DD>`).
 * Single source of truth — `dailyCounterKey` is imported from
 * `server/_shared/pro-mcp-token.ts` so a writer/reader drift cannot occur.
 *
 * Response shape:
 *   200 { used: number, limit: number | null, resetsAt: <ISO at next UTC midnight> }
 *
 * `limit` is the caller's PLAN allowance (plan 2026-07-25-001 U3b), resolved
 * from `features.planLimits.mcpCallsPerDay` through the SAME `resolveDailyLimit`
 * that `api/mcp/quota.ts` enforces with — `null` means unlimited. Before U3b
 * this reported a hardcoded 50, so a Pro Business user at 120 of 250 read
 * "50 / 50" in Settings while enforcement served them fine.
 *
 * Edge cases:
 *   - First call of the UTC day: Redis key missing → `used: 0`.
 *   - Malformed Redis value (non-numeric): treat as 0 (the counter is
 *     INCR-only; non-numeric values would be a serious upstream regression
 *     better surfaced as "0 today" than as a 500).
 *   - Redis transient: log + return `used: 0`. The settings UI is best-effort
 *     informational; we never want a broken Redis to block the settings tab.
 *   - Entitlement lookup unavailable (null, or throwing): fall back to the
 *     pre-U3b behaviour (50). Same cost-protection direction as enforcement,
 *     and a lookup blip must never 500 a previously-working endpoint.
 *
 * Status codes:
 *   - 200 OK on success
 *   - 401 if no/invalid Clerk session
 *   - 405 on non-GET methods
 *
 * Cache-Control: no-store — quota state changes per-call, never cache.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { resolveSession } from '../../server/_shared/auth-session';
import { getEntitlements } from '../../server/_shared/entitlement-check';
import { resolveDailyLimit, resolvePlanDrivenMcpAllowance } from '../mcp/quota';
import {
  dailyCounterKey,
  secondsUntilUtcMidnight,
} from '../../server/_shared/pro-mcp-token';
import { MCP_QUOTA_NAMESPACE, type CounterStub } from '../mcp/quota';
import { callCounter } from '../../worker/counters/protocol';

/** Inner handler — exported for unit tests with injected deps. */
export interface QuotaDeps {
  /** Resolves the Clerk userId from the request's Bearer header. Null = unauth. */
  resolveUserId: (req: Request) => Promise<string | null>;
  /**
   * Reads the daily counter key from Redis. Returns the stringified count
   * (Upstash returns INCR results as strings) or null if the key does not
   * exist. Throws on transport failure — the caller fail-softs to "0 used".
   */
  redisGet: (key: string) => Promise<string | null>;
  /**
   * Cached entitlement read for the plan allowance. Only `planKey` and
   * `features.planLimits.mcpCallsPerDay` are consumed; null/throw fall back
   * to the plan default via `resolveDailyLimit`.
   */
  getEntitlements: (userId: string) => Promise<{
    planKey?: string;
    features?: {
      planLimits?: { mcpCallsPerDay?: number | null };
    };
  } | null>;
  /** Injectable for deterministic tests. */
  now: () => Date;
  /**
   * Optional Durable Object counter stub (task 5, #cf-ratelimit-do). This
   * route is Vercel Edge Runtime today (see `config` above), which cannot
   * reach a Cloudflare Durable Object, so no real caller passes one yet and
   * `handler()` below always takes the Redis path. Once the reader and the
   * writer (`api/mcp/quota.ts`) both move to Workers and start passing a
   * stub, the Redis path can be deleted.
   */
  counterStub?: CounterStub | null;
}

const REDIS_OP_TIMEOUT_MS = 1_500;

async function rawRedisGetString(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: string | null };
  return typeof data?.result === 'string' ? data.result : null;
}

/**
 * Durable Object path. Branches on `present`, never on `count === 0` — a
 * missing key and a real zero both display as "0 used", but conflating the
 * two checks (`count === 0` alone) would silently paper over a DO read
 * failure that returns count 0 with present:false the same way the
 * legitimate first-request-of-the-day case does. Reading `present`
 * explicitly means a future caller who cares about the distinction (e.g.
 * telemetry) is not blocked by this function's own choice to treat them
 * the same for display purposes.
 */
async function readUsedViaCounter(
  stub: CounterStub,
  userId: string,
  limit: number | null,
): Promise<number> {
  try {
    const response = await callCounter(stub, {
      op: 'daily-read',
      namespace: MCP_QUOTA_NAMESPACE,
      userId,
    });
    if (response.op !== 'daily-read' || !response.present) return 0;
    // Cap displayed value at the resolved limit so a stale-rollover or test
    // injection cannot show "73 / 50". Unlimited plans have nothing to clamp
    // to — the raw counter IS the display value there.
    const counted = Math.max(response.count, 0);
    return limit === null ? counted : Math.min(counted, limit);
  } catch {
    // Best-effort: a DO read failure → report 0 used. The hard cap is
    // enforced server-side at reservation time; this endpoint is
    // informational.
    return 0;
  }
}

async function readUsedViaRedis(
  redisGet: QuotaDeps['redisGet'],
  userId: string,
  now: Date,
  limit: number | null,
): Promise<number> {
  const key = dailyCounterKey(userId, now);

  let raw: string | null = null;
  try {
    raw = await redisGet(key);
  } catch (err) {
    // Best-effort: Redis blip → report 0 used. The hard cap is enforced
    // server-side at INCR time; this endpoint is informational.
    console.warn(
      '[mcp-quota] Redis read failed:',
      err instanceof Error ? err.message : String(err),
    );
    captureSilentError(err, {
      tags: { route: 'api/user/mcp-quota', step: 'redis-get' },
    });
  }

  if (raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Cap displayed value at the resolved limit so a stale-rollover or test
  // injection cannot show "73 / 50". Unlimited plans have nothing to clamp
  // to — the raw counter IS the display value there.
  const floored = Math.floor(n);
  return limit === null ? floored : Math.min(floored, limit);
}

export async function quotaHandler(req: Request, deps: QuotaDeps): Promise<Response> {
  const cors = getCorsHeaders(req);
  const jsonHeaders = {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: 'GET, OPTIONS' },
    });
  }

  const userId = await deps.resolveUserId(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  const now = deps.now();
  // Plan allowance first — `used` is clamped to THIS number, not to the
  // historical 50. An unreadable entitlement leaves `planDailyLimit`
  // undefined, which resolveDailyLimit turns into the plan default. The
  // plan-family gate mirrors enforcement (`checkMcpEntitlementGate`): an
  // API-tier plan's catalog allowance is NOT what the meter applies, so it
  // must not be what this endpoint displays.
  let planDailyLimit: number | null | undefined;
  try {
    const ent = await deps.getEntitlements(userId);
    planDailyLimit = resolvePlanDrivenMcpAllowance(ent?.planKey, ent?.features?.planLimits?.mcpCallsPerDay);
  } catch (err) {
    console.warn(
      '[mcp-quota] entitlement lookup failed:',
      err instanceof Error ? err.message : String(err),
    );
    captureSilentError(err, {
      tags: { route: 'api/user/mcp-quota', step: 'entitlements' },
    });
  }
  const limit = resolveDailyLimit(planDailyLimit);

  const used = deps.counterStub
    ? await readUsedViaCounter(deps.counterStub, userId, limit)
    : await readUsedViaRedis(deps.redisGet, userId, now, limit);

  // Compute resetsAt deterministically from now + secondsUntilUtcMidnight.
  // Equivalent to floor-to-day + 1 day in UTC, but reuses the helper U7
  // already uses for Retry-After to guarantee the displayed countdown
  // matches the enforcement window exactly.
  const resetsAtMs = now.getTime() + secondsUntilUtcMidnight(now) * 1000;
  const resetsAt = new Date(resetsAtMs).toISOString();

  return new Response(
    JSON.stringify({ used, limit, resetsAt }),
    { status: 200, headers: jsonHeaders },
  );
}

export default async function handler(req: Request): Promise<Response> {
  return quotaHandler(req, {
    resolveUserId: async (r) => (await resolveSession(r))?.userId ?? null,
    redisGet: rawRedisGetString,
    getEntitlements,
    now: () => new Date(),
  });
}
