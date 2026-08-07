/**
 * Wire protocol for `CounterDO`. Every rate-limit primitive (sliding window,
 * daily meter, compare-and-delete lock) is a single POST body/response pair,
 * because a Durable Object only speaks HTTP over its stub.
 */
export type CounterRequest =
  | { op: 'sliding'; key: string; limit: number; windowMs: number }
  | {
      op: 'daily';
      namespace: string;
      userId: string;
      allowance: number;
      ttlSeconds: number;
      posture: 'allow' | 'deny';
      /**
       * Overrides the meter's default x10 safety ceiling. Deviation from the
       * task-3 brief (which had no field here): daily-meter.ts's
       * `MeterOptions.ceilingMultiplier` was added after the brief was
       * written, to let the MCP quota meter cap at x1 (its allowance IS its
       * hard cap) while the REST API-key meter keeps the x10 grace band.
       * Without this field on the wire, Task 5 (MCP quota, which needs x1)
       * would have no way to ask the DO for anything but the x10 default —
       * silently granting a 500-request ceiling where production caps at 50.
       * Omit to keep `reserveDaily`'s own default (CEILING_MULTIPLIER, x10).
       */
      ceilingMultiplier?: number;
    }
  | { op: 'daily-read'; namespace: string; userId: string }
  | { op: 'daily-rollback'; namespace: string; userId: string }
  | { op: 'compare-delete'; key: string; expected: string }
  | {
      /**
       * A replay-nonce cache: "have I seen this exact nonce within its TTL"
       * -- nothing calendar-shaped about it. Storage key is
       * `${namespace}:${nonce}` (no date component); expiry is driven only
       * by `ttlSeconds`, via the same increment-schedules-an-alarm path
       * `daily` already uses (counter-do.ts's `meterStore().increment`).
       *
       * Deliberately its own op rather than a `daily` reuse: `daily` routes
       * through `reserveDaily`, whose storage key comes from `dailyKey()` --
       * partitioned by UTC calendar day. A nonce cached under a day-
       * partitioned key stops answering "have I seen this nonce" the moment
       * the wall clock crosses midnight between one sighting and the next,
       * which is exactly the replay window this op exists to close. See
       * worker/routes/counter-read.ts's only caller for the full story.
       */
      op: 'nonce-check';
      namespace: string;
      nonce: string;
      ttlSeconds: number;
    };

export type CounterResponse =
  | { op: 'sliding'; success: boolean; limit: number; reset: number }
  | {
      op: 'daily';
      allowed: boolean;
      metered: boolean;
      count: number;
      overCeiling: boolean;
      reason?: 'storage-unavailable';
    }
  | { op: 'daily-read'; count: number; present: boolean }
  | { op: 'daily-rollback'; ok: true }
  | { op: 'compare-delete'; deleted: boolean }
  | {
      op: 'nonce-check';
      /** True when this nonce had already been recorded -- a replay. */
      seen: boolean;
      /** False on a storage failure: `seen` is meaningless in that case and
       *  the caller must treat the call as failed, not as "not seen". */
      metered: boolean;
      reason?: 'storage-unavailable';
    };

/**
 * `present` on daily-read is the whole reason this endpoint exists rather than
 * letting readers rebuild the key themselves. The old Convex reader mapped a
 * missing key to 0, which is indistinguishable from real zero usage — so a key
 * rename would have silently zeroed every user's usage with no error anywhere.
 * Callers must branch on `present`, not on `count === 0`.
 */
export async function callCounter(
  stub: { fetch(request: Request): Promise<Response> },
  req: CounterRequest,
): Promise<CounterResponse> {
  const response = await stub.fetch(
    new Request('https://counter.internal/', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: { 'content-type': 'application/json' },
    }),
  );
  if (!response.ok) {
    throw new Error(`counter DO returned ${response.status}`);
  }
  return (await response.json()) as CounterResponse;
}
