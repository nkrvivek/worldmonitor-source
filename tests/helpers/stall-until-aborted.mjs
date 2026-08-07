/**
 * A stubbed request that answers nothing until the caller aborts it.
 *
 * The referenced timer is the point. Node's `AbortSignal.timeout` timer is
 * unref'd, so it cannot hold the process open by itself: a stub that only
 * listens for `abort` leaves nothing referenced, the event loop drains before
 * the abort fires, and node:test fails every test from that point on with
 * 'Promise resolution is still pending but the event loop has already
 * resolved' instead of running them. In production a real fetch's socket holds
 * the loop open; here this timer does.
 *
 * It also rejects with a readable message when the code under test never
 * aborts at all, so a missing deadline reads as a missing deadline.
 *
 * @param {AbortSignal} signal the signal the code under test passed to fetch
 * @param {number} [holdMs] how long to wait for that abort before giving up
 * @returns {Promise<never>} rejects with the abort reason, or with an error
 */
export function stallUntilAborted(signal, holdMs = 5_000) {
  return new Promise((_resolve, reject) => {
    const rejectForAbort = () => reject(
      signal.reason ?? new DOMException('Timed out', 'TimeoutError'),
    );
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    const hold = setTimeout(
      () => reject(new Error(`nothing aborted the stalled request within ${holdMs}ms`)),
      holdMs,
    );
    signal.addEventListener('abort', () => {
      clearTimeout(hold);
      rejectForAbort();
    }, { once: true });
  });
}
