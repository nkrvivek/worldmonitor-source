/**
 * Duration parsing, moved here unchanged from `api/_rate-limit-fallback.js`
 * (which Task 7 deletes once every Upstash call site is gone). Mirrors
 * `@upstash/ratelimit`'s internal (unexported) `ms()` helper: same regex,
 * same per-unit seconds table, same `Math.max(1, Math.ceil(...))` floor.
 *
 * `Math.ceil`, not `Math.floor`: a sub-second remainder must round the
 * window UP, never down — a caller-facing window of "0 seconds" would
 * turn a rate limit into an unconditional allow (nothing to divide by / an
 * always-open bucket per second). None of the current policy windows
 * ('60 s', '1 h', etc.) have a fractional-second remainder, so ceil and
 * floor agree in practice today, but the two are not interchangeable in
 * general and the old file's behavior (ceil) is what this must reproduce.
 */
export function durationToSeconds(window: string): number {
  const match = /^(\d+)\s?(ms|s|m|h|d)$/.exec(window);
  if (!match) throw new Error(`Unable to parse rate-limit window: ${window}`);
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const unitSeconds: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400 };
  return Math.max(1, Math.ceil(value * (unitSeconds[unit] ?? 1)));
}
