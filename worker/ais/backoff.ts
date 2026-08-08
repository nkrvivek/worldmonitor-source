/**
 * Full-jitter exponential backoff for the upstream AISStream reconnect.
 *
 * The Node relay retried with a fixed unconditional
 * `setTimeout(connectUpstream, 5000)`. A Durable Object cannot do that: it can
 * be evicted between the close event and the timer firing, and the timer dies
 * with it. So the alarm in worker/ais/relay-do.ts checks `now >= reconnectAt`
 * on every tick, and this module decides how far ahead that instant sits.
 *
 * 1s base, 60s cap. At low attempt counts the wait is comparable to the old
 * fixed 5s retry; during a real AISStream outage it backs off instead of
 * hammering the host.
 */
const BASE_MS = 1_000;
const CAP_MS = 60_000;

/**
 * Clamp for the attempt counter where Task 5 writes it to storage, not for the
 * exponent here — `Math.min(CAP_MS, ...)` already makes anything past ~6 moot.
 * An unbounded integer stored across months of running is still worth capping
 * at the write site. Exported so that site clamps to the number this module
 * assumes.
 */
export const MAX_BACKOFF_ATTEMPT = 20;

export function computeBackoffMs(attempt: number): number {
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}
