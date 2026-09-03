#!/usr/bin/env node
/**
 * Runs one seed script and records what happened.
 *
 * A bundle already does this for itself: scripts/_bundle-runner.mjs writes
 * `seed-run:<bundle>` because a section that fails only inside a Cloudflare
 * container leaves no trace anyone can read. `wrangler tail` shows the cron
 * invocation and the container's start RPC with `logs: []`, and
 * `wrangler containers` has no logs subcommand. That is how the FATF section
 * stayed broken while the other fourteen in its bundle ran clean.
 *
 * A standalone script on a cron line had no such record, and the same failure
 * happened one layer up. seed-fuel-prices.mjs wrote nothing on two consecutive
 * Sunday ticks while seed-bigmac.mjs, on the same tick and in the same image,
 * wrote fine. Cloudflare reported both invocations as successes, because
 * worker/seeds/scheduled.ts catches a failed start per script so one dead seed
 * cannot stop its siblings. Nothing was wrong with the cron, the registry or
 * Redis, and nothing anywhere said which script had died or why. Health only
 * noticed ten days later, when the cache TTL expired the key.
 *
 * So every scheduled script now runs through here. The record is one Redis key
 * holding the exit code, the duration and the tail of the output.
 *
 * Usage: node scripts/run-seed-recorded.mjs <script> [args...]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GRACEFUL_FETCH_FAILURE_EXIT_CODE } from './_seed-utils.mjs';

/** Same namespace and lifetime as the bundle runner's records. */
const RUN_RECORD_KEY_PREFIX = 'seed-run:script:';
const RUN_RECORD_TTL_SECONDS = 35 * 86_400;

/**
 * How much of the child's output the record keeps.
 *
 * The tail, not the head: a seed prints its progress as it goes and its
 * verdict at the end, so the last lines are the ones that say why a run
 * failed. Upstash rejects a value over 1 MB and a chatty seed can print far
 * more than that, so this is a cap, not a budget.
 */
const TAIL_LIMIT = 16_000;


/**
 * Persist one record, best effort.
 *
 * Never throws and never changes the exit code. A seed that did its work must
 * still report success when Redis is unreachable, and a seed that failed must
 * still report failure when the record cannot be written. Say which way the
 * write failed rather than claiming a write that did not happen.
 */
export async function writeRunRecord(key, value, fetchImpl = fetch) {
  // Read at call time, not at import: the container supplies these through
  // envVars on the start RPC, and a test needs to set them around one call.
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    console.error(`[run-seed] no Redis credentials — run record for ${key} not written`);
    return false;
  }
  try {
    const resp = await fetchImpl(redisUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', RUN_RECORD_TTL_SECONDS]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return true;
  } catch (err) {
    console.error(`[run-seed] run record write failed for ${key}: ${err?.message || err}`);
    return false;
  }
}

/** Keeps the last `limit` characters of everything appended. */
export function makeTail(limit = TAIL_LIMIT) {
  let held = '';
  return {
    append(chunk) {
      held += chunk;
      if (held.length > limit * 2) held = held.slice(-limit);
    },
    read() {
      return held.length > limit ? held.slice(-limit) : held;
    },
  };
}

/**
 * The wrapper's own work, guarded so a test can import the helpers above
 * without spawning anything.
 */
function main() {
  const [script, ...args] = process.argv.slice(2);
  if (!script) {
    console.error('run-seed-recorded: no script given');
    process.exit(2);
  }

  const startedAt = Date.now();
  const tail = makeTail();

  const child = spawn('node', [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Pass the output straight through as well. On a container nobody reads it,
  // which is the whole reason for the record; on a GitHub runner or a laptop it
  // is the log, and swallowing it here would be a regression.
  child.stdout.on('data', (chunk) => {
    tail.append(chunk.toString());
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    tail.append(chunk.toString());
    process.stderr.write(chunk);
  });

  // Pass a stop on to the seed. Without this the wrapper dies on SIGTERM and
  // leaves the child running with no parent, so a container shutdown would
  // interrupt the seed mid-write instead of letting it finish its own cleanup.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        // The child is already gone; the close handler still writes the record.
      }
    });
  }

  child.on('error', async (err) => {
    // The script never started: a bad path, a missing binary. Distinct from a
    // script that ran and exited non-zero, and worth saying so in the record.
    const finishedAt = Date.now();
    await writeRunRecord(`${RUN_RECORD_KEY_PREFIX}${script}`, {
      fetchedAt: finishedAt,
      script,
      startedAt,
      durationMs: finishedAt - startedAt,
      code: null,
      signal: null,
      status: 'START_ERROR',
      reason: err?.message || String(err),
      tail: tail.read(),
    });
    console.error(`[run-seed] ${script} failed to start: ${err?.message || err}`);
    process.exit(1);
  });

  child.on('close', async (code, signal) => {
    const finishedAt = Date.now();
    // GRACEFUL is its own word. A seed that exits 75 decided a source was
    // unreachable and declined to publish rather than publishing something
    // wrong, which _bundle-runner.mjs already counts separately from a crash.
    // Reading it as FAILED would put a working seed on the same line as a
    // broken one.
    const status = signal
      ? 'SIGNALLED'
      : code === 0
        ? 'OK'
        : code === GRACEFUL_FETCH_FAILURE_EXIT_CODE
          ? 'GRACEFUL'
          : 'FAILED';
    const key = `${RUN_RECORD_KEY_PREFIX}${script}`;
    const recorded = await writeRunRecord(key, {
      fetchedAt: finishedAt,
      script,
      startedAt,
      durationMs: finishedAt - startedAt,
      code,
      signal,
      status,
      tail: tail.read(),
    });
    if (recorded) console.log(`[run-seed] ${script} ${status} in ${((finishedAt - startedAt) / 1000).toFixed(1)}s — record at ${key}`);
    // The child's verdict is the wrapper's verdict. A signalled child has no
    // exit code, and reporting 0 there would turn a killed seed into a clean run.
    process.exit(signal ? 1 : (code ?? 1));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
