/**
 * The two meters this replaces both did INCR-then-EXPIRE and both ignored
 * EXPIRE's result, reading only the counter. Storage here is that same
 * contract, narrowed to what a Durable Object can promise atomically.
 */
export interface MeterStore {
  /** Increment and return the new value. Sets the TTL on first write. */
  increment(key: string, ttlSeconds: number): Promise<number>;
  decrement(key: string): Promise<void>;
}

/**
 * 'allow' reproduces server/_shared/api-key-rate-limit.ts::reserveDailyMeter: a
 * storage outage must never punish a paying customer, so a failed increment
 * serves the request uncounted. 'deny' reproduces api/mcp/quota.ts::reserveQuota:
 * a hard cap that will not dispatch work it cannot account for, so a failed
 * increment rejects. Both postures are load-bearing production behavior today
 * and neither is a default.
 */
export type StorageFailurePosture = 'allow' | 'deny';

/**
 * Safety-ceiling multiplier. This unifies the two callers' *ceiling*
 * concept, not their reject point: api-key-rate-limit.ts already treats its
 * daily allowance as informational (the meter itself never rejects; the
 * gateway alone decides whether to reject at CEILING_MULTIPLIER x allowance).
 * api/mcp/quota.ts, by contrast, rejects and self-rolls-back the instant the
 * *allowance itself* (PRO_DAILY_QUOTA_LIMIT) is exceeded, with no ceiling
 * multiplier concept at all. This function generalizes to the decision-only
 * shape: it always reports `count` and `overCeiling`, and never rejects a
 * successful storage read on its own. A caller that wants quota.ts's old
 * "hard reject at the allowance" behavior must check `count > allowance`
 * (or `overCeiling`, if it wants the x10 grace band instead) itself and call
 * `rollback()` when it decides to reject — the auto-rollback used to live
 * inside reserveQuota; it now lives at the call site.
 */
export const CEILING_MULTIPLIER = 10;

export interface MeterOptions {
  namespace: string;
  userId: string;
  allowance: number;
  ttlSeconds: number;
  onStorageFailure: StorageFailurePosture;
  now: Date;
  /**
   * Overrides CEILING_MULTIPLIER for this call. The two callers this
   * function unifies want different ceilings: the REST API-key meter's real
   * ceiling is allowance x10 (informational only, gateway decides), while
   * the MCP quota meter's real cap is the allowance itself (x1, since
   * quota.ts rejected at the allowance with no grace band). Omit to keep
   * the brief's literal x10 default.
   */
  ceilingMultiplier?: number;
}

export interface MeterResult {
  allowed: boolean;
  /** False when the request was not counted — bad input or a storage failure. */
  metered: boolean;
  count: number;
  overCeiling: boolean;
  reason?: 'storage-unavailable';
  rollback: () => Promise<void>;
}

const NO_OP_ROLLBACK = async (): Promise<void> => {};

export function dailyKey(namespace: string, userId: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${namespace}:${userId}:${yyyy}-${mm}-${dd}`;
}

/**
 * DO instance name for a namespace+user daily meter. This is the shard name
 * that the `daily-read` route (worker/routes/counter-read.ts) and EVERY
 * future writer of a daily meter -- including Task 6b's
 * server/_shared/api-key-rate-limit.ts, which does not exist yet -- must
 * agree on. `dailyKey()` above sets the STORAGE key inside one DO instance;
 * this sets WHICH instance answers for a given namespace+user, one level up.
 *
 * There is no protocol-level check that a reader and a writer picked the
 * same instance. Get this wrong and the failure is silent: the read
 * succeeds, returns `{ present: false, count: 0 }`, and looks like "this
 * user has no usage yet" instead of "wrong shard" -- there is no error to
 * catch it. Import this function rather than reconstructing the string.
 */
export function dailyMeterShardName(namespace: string, userId: string): string {
  return `${namespace}:${userId}`;
}

export async function reserveDaily(
  store: MeterStore,
  opts: MeterOptions,
): Promise<MeterResult> {
  if (opts.allowance <= 0) {
    // An unlimited plan is not a storage failure — always allow.
    return { allowed: true, metered: false, count: 0, overCeiling: false, rollback: NO_OP_ROLLBACK };
  }

  if (!opts.userId) {
    // No userId means nothing can be metered, but that is not by itself a
    // reason to allow: route it through the same posture a storage outage
    // would take. Neither posture is a default.
    const allowed = opts.onStorageFailure === 'allow';
    return {
      allowed, metered: false, count: 0, overCeiling: false,
      reason: 'storage-unavailable', rollback: NO_OP_ROLLBACK,
    };
  }

  const key = dailyKey(opts.namespace, opts.userId, opts.now);

  let count: number;
  try {
    count = await store.increment(key, opts.ttlSeconds);
  } catch {
    const allowed = opts.onStorageFailure === 'allow';
    return {
      allowed, metered: false, count: 0, overCeiling: false,
      reason: 'storage-unavailable', rollback: NO_OP_ROLLBACK,
    };
  }

  if (!Number.isFinite(count) || count < 1) {
    // A counter that reads back as nonsense is a storage fault, not a real zero.
    const allowed = opts.onStorageFailure === 'allow';
    return {
      allowed, metered: false, count: 0, overCeiling: false,
      reason: 'storage-unavailable', rollback: NO_OP_ROLLBACK,
    };
  }

  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await store.decrement(key);
    } catch {
      // Swallowed on purpose. An overshoot leaves the caller counted slightly
      // high, which is the cost-safe direction; a throw here would mask the
      // real error the caller is already handling.
    }
  };

  const ceilingMultiplier = opts.ceilingMultiplier ?? CEILING_MULTIPLIER;

  return {
    allowed: true,
    metered: true,
    count,
    overCeiling: count > opts.allowance * ceilingMultiplier,
    rollback,
  };
}
