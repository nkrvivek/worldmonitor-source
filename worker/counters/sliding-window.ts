/** Counts for the current and immediately preceding fixed windows. */
export interface WindowState {
  currentCount: number;
  previousCount: number;
  /** Epoch ms at which the current window opened. */
  windowStart: number;
}

export interface WindowDecision {
  success: boolean;
  limit: number;
  /** Epoch ms when the current window closes. Callers surface this as Retry-After. */
  reset: number;
  /** The weighted count this decision was made on. Exposed for tests and logs. */
  observedCount: number;
}

/**
 * Sliding window over two fixed buckets, matching @upstash/ratelimit's
 * singleRegion `slidingWindow` algorithm (v2.0.8) exactly.
 *
 * Read from node_modules/@upstash/ratelimit/dist/index.mjs, `slidingWindowLimitScript`
 * (the Lua script backing `Ratelimit.slidingWindow`, which is what this
 * codebase instantiates everywhere — see api/_rate-limit.js,
 * server/_shared/rate-limit.ts, api/mcp/auth.ts, etc.):
 *
 *   local percentageInCurrent = ( now % window ) / window
 *   requestsInPreviousWindow = math.floor(( 1 - percentageInCurrent ) * requestsInPreviousWindow)
 *   if incrementBy > 0 and requestsInPreviousWindow + requestsInCurrentWindow >= effectiveLimit then
 *     return {-1, effectiveLimit}
 *   end
 *
 * Two things that matter and that this function must reproduce:
 *
 * 1. The previous window's weighted contribution is floored with
 *    `math.floor` BEFORE it is added to the current window's count. It is
 *    not left fractional. (The current window's count is always an
 *    integer already, so there's nothing to floor there.)
 * 2. The boundary is `>=`: a request is rejected when the observed count is
 *    already at or above the limit *before* this request's own increment is
 *    applied. Equivalently, success is `observedCount < limit`.
 *
 * `reset` mirrors the wrapping TS (`(currentWindow + 1) * windowSize`, i.e.
 * the start of the next fixed window) which is `windowStart + windowMs`
 * given a `windowStart` aligned to a window boundary.
 */
export function slidingWindowDecide(
  state: WindowState,
  now: number,
  limit: number,
  windowMs: number,
): WindowDecision {
  const elapsed = now - state.windowStart;
  // Defensive clamp on both ends: Upstash derives its weight from
  // `now % window`, which by construction always falls in [0, window), so
  // its `1 - percentageInCurrent` is always in (0, 1] — never below 0 or
  // above 1. Our state carries a caller-supplied `windowStart` instead of
  // deriving it from `now`, so a stale/future-dated `windowStart` (clock
  // skew, out-of-order write) could otherwise push `elapsed` negative,
  // driving the weight above 1 and over-counting the previous window by
  // more than its own size. Clamping `elapsed` to [0, windowMs] keeps the
  // weight in the same [0, 1] range Upstash's modulo guarantees.
  const clampedElapsed = Math.min(Math.max(elapsed, 0), windowMs);
  const previousWeight = 1 - clampedElapsed / windowMs;
  const weightedPrevious = Math.floor(state.previousCount * previousWeight);
  const observedCount = state.currentCount + weightedPrevious;

  return {
    success: observedCount < limit,
    limit,
    reset: state.windowStart + windowMs,
    observedCount,
  };
}
