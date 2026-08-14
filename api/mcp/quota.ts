import {
  dailyCounterKey,
  PRO_DAILY_QUOTA_LIMIT,
  PRO_DAILY_QUOTA_TTL_SECONDS,
} from '../../server/_shared/pro-mcp-token';
import { callCounter, type CounterResponse } from '../../worker/counters/protocol';
import type { PipelineFn, QuotaRejected, QuotaReserved } from './types';

// ---------------------------------------------------------------------------
// Daily quota helpers (Pro-only). INCR-first reservation runs synchronously
// on the critical path BEFORE tool dispatch — never inside `waitUntil`.
// On pre-dispatch cap rejection we best-effort DECR/rollback. Once dispatch
// begins, callers keep the slot charged even if execution later errors or
// exceeds budget.
//
// The cap itself is plan-driven (plan 2026-07-25-001 U3): the caller passes the
// allowance resolved from the entitlement, and `PRO_DAILY_QUOTA_LIMIT` is the
// fallback for anyone who can't supply one. Both backends below enforce that
// same resolved number.
//
// Two backends, one contract (task 5, #cf-ratelimit-do). `reserveQuota` now
// accepts an optional Durable Object counter stub alongside the original
// Redis pipeline. `api/mcp/` is served by Vercel Edge Runtime today, which
// cannot reach a Cloudflare Durable Object — so no real caller passes a stub
// yet (api/mcp/dispatch.ts still calls
// `reserveQuota(context.userId, deps.redisPipeline, mcpDailyLimit)`), and every
// request keeps taking the Redis leg below, unchanged. A later task moves the MCP
// handlers onto Workers and starts passing a real stub; once every caller
// does, the Redis leg (and `PipelineFn`) can be deleted.
// ---------------------------------------------------------------------------

/**
 * Minimal Durable Object stub shape — the same duck-typed interface
 * `callCounter` (worker/counters/protocol.ts) accepts. Declared locally
 * instead of importing `server/_shared/rate-limit.ts`'s `CounterStub` so this
 * file doesn't pull that module's @upstash/ratelimit + @upstash/redis imports
 * in for what is otherwise a purely structural type.
 */
export interface CounterStub {
  fetch(request: Request): Promise<Response>;
}

// Matches the base of `dailyCounterKey` (`mcp:pro-usage:<userId>:<date>`).
// The DO path builds its own `${namespace}:${userId}:${date}` key internally
// (worker/counters/daily-meter.ts::dailyKey) — it never goes through
// `dailyCounterKey` or its env-prefix, because a CounterDO instance is
// already isolated by binding/environment, unlike the shared Upstash
// instance the prefix exists to protect from preview/production collision.
export const MCP_QUOTA_NAMESPACE = 'mcp:pro-usage';

/**
 * Normalise a plan-resolved allowance into the value this module enforces.
 *
 * `null` (unlimited) passes through; a finite non-negative number is honoured
 * verbatim — including `0`, which is a real "no allowance" and must not be
 * mistaken for a missing one. EVERYTHING else — undefined, a legacy row with no
 * `planLimits`, NaN/Infinity, a negative, a stringified number — resolves to
 * `PRO_DAILY_QUOTA_LIMIT`. That direction is deliberate: an unreadable limit
 * must never buy a caller a HIGHER cap than the plan default.
 *
 * Exported because the settings-UI reader (`api/user/mcp-quota.ts`) must DISPLAY
 * exactly the limit this module ENFORCES. A second copy of this normalisation
 * would be the drift the endpoint's whole reason for existing is to prevent.
 */
export function resolveDailyLimit(planDailyLimit?: number | null): number | null {
  if (planDailyLimit === null) return null;
  if (typeof planDailyLimit === 'number' && Number.isFinite(planDailyLimit) && planDailyLimit >= 0) {
    return planDailyLimit;
  }
  return PRO_DAILY_QUOTA_LIMIT;
}

/**
 * Plans whose catalog `mcpCallsPerDay` must NOT drive the daily cap on the
 * pro (OAuth) MCP context. The KTD6 boundary is a PLAN boundary, not a
 * credential boundary: API-tier subscribers can mint pro OAuth tokens too
 * (tier>=1 + mcpAccess), and without this gate their catalog allowance
 * (1000/10000) would leak through the OAuth door while their `user_key`
 * stays hardcoded at 50. Raising API-tier MCP allowances is a deliberate
 * follow-up; until then both credential classes must agree on the cap.
 */
const API_TIER_MCP_CAPPED_PLAN_KEYS = new Set([
  'api_starter',
  'api_starter_annual',
  'api_business',
  'api_business_annual',
]);

/**
 * Gate a plan-resolved MCP allowance on plan family: API-tier plans report
 * `undefined` (→ the 50/day default via `resolveDailyLimit`); every other
 * plan's allowance passes through verbatim — pro/pro_business plan-driven
 * numbers, enterprise's `null` (unlimited), free's `0`.
 *
 * Shared by the enforcement path (`checkMcpEntitlementGate`) and the
 * settings display (`api/user/mcp-quota.ts`) so the number a user reads is
 * the number the reservation applies.
 */
export function resolvePlanDrivenMcpAllowance(
  planKey: string | undefined,
  mcpCallsPerDay: number | null | undefined,
): number | null | undefined {
  if (planKey && API_TIER_MCP_CAPPED_PLAN_KEYS.has(planKey)) return undefined;
  return mcpCallsPerDay;
}

export async function reserveQuota(
  userId: string,
  pipeline: PipelineFn,
  planDailyLimit?: number | null,
  counterStub?: CounterStub | null,
): Promise<QuotaReserved | QuotaRejected> {
  if (counterStub) return reserveQuotaViaCounter(userId, counterStub, resolveDailyLimit(planDailyLimit));
  return reserveQuotaViaRedis(userId, pipeline, planDailyLimit);
}

/**
 * Durable Object path. The DO writes the counter value directly (no
 * INCR/DECR/EXPIRE round-trip contract to route around), so it needs none of
 * the Redis leg's overshoot-recovery walk below — that walk exists only
 * because the injected Redis pipeline can express INCR/DECR/EXPIRE and
 * nothing else. Do not port it here.
 *
 * `limit` arrives already resolved (`resolveDailyLimit`): `null` is unlimited,
 * and any number — including `0` — is the exact boundary to reject past.
 */
async function reserveQuotaViaCounter(
  userId: string,
  stub: CounterStub,
  limit: number | null,
): Promise<QuotaReserved | QuotaRejected> {
  let response: CounterResponse;
  try {
    response = await callCounter(stub, {
      op: 'daily',
      namespace: MCP_QUOTA_NAMESPACE,
      userId,
      // Metering allowance only — the rejection boundary is `limit`, applied
      // below. reserveDaily (worker/counters/daily-meter.ts) treats
      // `allowance <= 0` as "unlimited, do not meter", which is the opposite
      // of what a plan-resolved 0/day means here, and an unlimited plan must
      // still be counted. Both cases therefore meter against the plan default
      // and let the check below decide.
      allowance: limit === null || limit <= 0 ? PRO_DAILY_QUOTA_LIMIT : limit,
      ttlSeconds: PRO_DAILY_QUOTA_TTL_SECONDS,
      // Hard cap, no fail-open: mirrors the Redis leg's "NEVER dispatch on
      // reservation failure" below — a falsy userId or a storage outage both
      // reject rather than serve an uncounted request.
      posture: 'deny',
      // MeterOptions.ceilingMultiplier (worker/counters/daily-meter.ts) was
      // added in task 3 for exactly this call site: "the MCP quota meter's
      // real cap is the allowance itself (x1, since quota.ts rejected at the
      // allowance with no grace band)." x1 keeps the DO's own `overCeiling`
      // in agreement with the check below whenever the allowance sent above
      // IS the limit; without it the DO would report against a x10 grace band
      // this file has never had.
      ceilingMultiplier: 1,
    });
  } catch {
    return { ok: false, reason: 'redis-unavailable' };
  }

  if (response.op !== 'daily' || !response.metered) {
    // `metered: false` covers both the storage-outage and the falsy-userId
    // cases — both are routed through `posture: 'deny'`, and reserveDaily
    // (worker/counters/daily-meter.ts) maps either to
    // `reason: 'storage-unavailable'`. The caller's contract
    // (api/mcp/dispatch.ts) still speaks `redis-unavailable`; that string
    // doesn't get renamed just because Redis is no longer the only backend.
    return { ok: false, reason: 'redis-unavailable' };
  }

  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await callCounter(stub, { op: 'daily-rollback', namespace: MCP_QUOTA_NAMESPACE, userId });
    } catch {
      // Best-effort: a transient failure means the counter overshoots by 1,
      // which is the cost-protection-correct direction.
    }
  };

  // `response.allowed` is NOT the hard-cap signal — reserveDaily reports
  // `allowed: true` on every successful increment regardless of `count` vs
  // `allowance`, so it can never distinguish "over the cap" from "storage
  // outage" for a `posture: 'deny'` caller. Compare the returned count to the
  // resolved limit instead, the same expression the Redis leg rejects on
  // (`newCount > limit`), so a plan-driven 0 or 250 lands on exactly the same
  // boundary through either backend.
  if (limit !== null && response.count > limit) {
    // Reject and roll back immediately — no awaits in between the check and
    // the rollback call, keeping the reservation-to-rollback window as tight
    // as the Redis leg's. (CounterDO.dailyRollback derives its key from
    // `new Date()` at rollback time rather than the reservation's date, so a
    // rollback that lands after a UTC-midnight rollover would decrement the
    // wrong day's key — a known, deferred edge case; this call site does
    // nothing to widen that window.)
    await rollback();
    return { ok: false, reason: 'cap-exceeded', floor: limit };
  }

  return { ok: true, newCount: response.count, rollback };
}

/**
 * Redis pipeline path — production behavior, unchanged, including the
 * overshoot-recovery walk below. Kept verbatim for as long as any real
 * caller reaches this file without a Durable Object binding (Vercel Edge
 * Runtime, today, for every real caller — see the module comment above).
 */
async function reserveQuotaViaRedis(
  userId: string,
  pipeline: PipelineFn,
  planDailyLimit?: number | null,
): Promise<QuotaReserved | QuotaRejected> {
  // `null` = unlimited: the counter still moves (metering is not optional) but
  // the rejection branch below is skipped entirely.
  const limit = resolveDailyLimit(planDailyLimit);
  const key = dailyCounterKey(userId);
  if (!key) return { ok: false, reason: 'redis-unavailable' };

  let pipeResult: Array<{ result: unknown }> | null;
  try {
    pipeResult = await pipeline([
      ['INCR', key],
      ['EXPIRE', key, PRO_DAILY_QUOTA_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    // Hard cap correctness: NEVER dispatch on reservation failure.
    return { ok: false, reason: 'redis-unavailable' };
  }

  const incrRaw = pipeResult[0]?.result;
  const newCount = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(newCount) || newCount < 1) {
    return { ok: false, reason: 'redis-unavailable' };
  }

  // Build idempotent rollback. `await rollback()` runs DECR once; subsequent
  // calls are no-ops.
  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await pipeline([['DECR', key]]);
    } catch {
      // Best-effort: a transient Redis failure means the counter overshoots
      // by 1, which is the cost-protection-correct direction.
    }
  };

  if (limit !== null && newCount > limit) {
    // Reject and roll back immediately so the floor stays at the limit
    // (or wherever concurrent rollbacks land it).
    await rollback();

    // Counter-clamp (F4): if multiple DECR rollbacks have failed during
    // a Redis hiccup, the counter can overshoot indefinitely (e.g. land
    // at 2x the limit). Without clamping, every subsequent INCR for the
    // rest of the UTC day yields >limit → the user is locked out until
    // the 48h key TTL expires. The clamp target is the RESOLVED limit,
    // not the plan default — clamping a 250/day caller down to 50 would
    // hand them 200 free calls on the next Redis hiccup.
    //
    // After the rollback, peek at the post-DECR count via a single
    // best-effort INCR-then-DECR pair — if it's STILL above the limit,
    // we know the rollback didn't land. Force a defensive
    // `SET key <limit> KEEPTTL` so the next legitimate INCR (next UTC
    // day OR next request after the hiccup) starts at limit+1 → 429,
    // not limit+N → 429-forever.
    //
    // Why use INCR-then-DECR instead of GET? Keeps the helper to the
    // same pipeline contract (the tests' makePipelineMock supports
    // INCR/DECR/EXPIRE only) and avoids adding a new verb. The probe
    // costs one round-trip but only on the rejection path.
    if (newCount > limit + 1) {
      try {
        const probe = await pipeline([['INCR', key], ['DECR', key]]);
        const probeIncrRaw = probe?.[0]?.result;
        const postRollbackCount = typeof probeIncrRaw === 'number' ? probeIncrRaw - 1 : Number.NaN;
        if (Number.isFinite(postRollbackCount) && postRollbackCount > limit) {
          // Rollback chain has overshot — force the counter back to the
          // limit via SET KEEPTTL. This is fail-soft: a concurrent INCR
          // immediately after this SET will land at limit+1 and 429
          // normally, which is the desired behavior.
          //
          // Use DECR repeatedly as the pipeline-supported clamp (avoids
          // adding a new verb to test mocks). DECR N times where N is
          // the overshoot delta. Cap at 100 DECRs to bound the worst-
          // case round-trip cost.
          const overshoot = postRollbackCount - limit;
          const decrs = Math.min(overshoot, 100);
          const clamp = Array.from({ length: decrs }, () => ['DECR', key] as Array<string | number>);
          // Best-effort: failure here is the cost-protection-correct
          // direction (counter stays high → users 429, no DoS exposure).
          await pipeline(clamp).catch(() => {});
        }
      } catch {
        // Probe failed — leave counter as-is. Worst case the user 429s
        // until UTC midnight; never under-cap, never DoS exposure.
      }
    }

    return { ok: false, reason: 'cap-exceeded', floor: limit };
  }

  return { ok: true, newCount, rollback };
}
