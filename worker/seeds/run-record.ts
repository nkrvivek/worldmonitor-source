/**
 * The run record for a seed whose container never started.
 *
 * scripts/run-seed-recorded.mjs writes `seed-run:script:<path>` from inside
 * the container, which covers every way a seed can fail once it is running.
 * It cannot cover the step before that. worker/seeds/scheduled.ts catches a
 * failed `.start()` per script so one dead seed cannot stop its siblings, and
 * the only trace left was a console.error nobody can read: `wrangler tail`
 * shows the invocation with `logs: []` and `wrangler containers` has no logs
 * subcommand. Cloudflare reports the cron a success either way.
 *
 * So a refused start looked exactly like a cron that never fired, and the
 * pair is indistinguishable in the one place anyone looks. Measured
 * 2026-08-19: seed-supply-chain-trade.mjs missed its 12:00 tick, and both
 * supply_chain:shipping:v2 and trade:tariffs:v1:840:all:10 aged past their
 * bounds with nothing anywhere saying which step had failed.
 *
 * This writes the missing half, in the same key and the same shape the
 * in-container recorder uses, under its own status word.
 */

/** Same namespace and lifetime as scripts/run-seed-recorded.mjs. */
export const RUN_RECORD_KEY_PREFIX = 'seed-run:script:';
export const RUN_RECORD_TTL_SECONDS = 35 * 86_400;

/** How long to wait on the Redis write before giving up on it. */
const WRITE_TIMEOUT_MS = 5_000;

/**
 * Any env bag. The two keys are read off it and validated at runtime rather
 * than declared here: a stricter all-optional type is a weak type, and TS
 * rejects the Worker's own env for having "no properties in common" with it.
 */
type RedisCredentials = Record<string, unknown>;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Persist one start-failure record, best effort.
 *
 * Never throws. The caller is already handling a failure and must go on to
 * start the sibling seeds; a Redis outage on top of a container outage cannot
 * be allowed to take those down too. Returns whether the record was written,
 * so the caller can say which way it went instead of claiming a write that
 * did not happen.
 */
export async function writeStartFailureRecord(
  env: RedisCredentials,
  script: string,
  err: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const redisUrl = typeof env.UPSTASH_REDIS_REST_URL === 'string' ? env.UPSTASH_REDIS_REST_URL : '';
  const redisToken =
    typeof env.UPSTASH_REDIS_REST_TOKEN === 'string' ? env.UPSTASH_REDIS_REST_TOKEN : '';
  if (!redisUrl || !redisToken) return false;

  const now = Date.now();
  const record = {
    fetchedAt: now,
    script,
    startedAt: now,
    durationMs: 0,
    code: null,
    signal: null,
    // Its own word, not the recorder's START_ERROR: that one means the
    // container came up and could not spawn node, this one means the
    // container never came up at all.
    status: 'CONTAINER_START_FAILED',
    reason: err instanceof Error ? err.message : String(err),
    tail: '',
  };

  try {
    const resp = await fetchImpl(redisUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        'SET',
        `${RUN_RECORD_KEY_PREFIX}${script}`,
        JSON.stringify(record),
        'EX',
        RUN_RECORD_TTL_SECONDS,
      ]),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
