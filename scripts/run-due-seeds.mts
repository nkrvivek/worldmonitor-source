/**
 * Run the seed scripts that were due in the last N minutes.
 *
 * The fallback for a scheduler outage. On 2026-08-07 Cloudflare stopped firing
 * cron triggers account-wide at 20:50Z — two unrelated workers went quiet
 * within a minute of each other, no incident was ever posted for it, and a
 * redeploy did not re-arm anything. The site's OK count fell 139 → 120 over
 * ninety minutes with nothing wrong in the Worker, the registry, or Redis.
 *
 * The seeds themselves need none of that machinery: each is a standalone Node
 * program that writes to Upstash over REST. So this runner asks the registry
 * what would have fired, and runs it.
 *
 * Usage:
 *   tsx scripts/run-due-seeds.mts [--since-minutes N] [--concurrency N] [--dry-run]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MAX_WINDOW_MINUTES, dueScripts } from '../worker/seeds/due';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Matches the workflow's own cadence with a minute of overlap. Cron minutes
 * are matched exactly, so a window that lines up flush with the schedule drops
 * a job whenever the runner starts a few seconds late. Overlap costs a
 * repeated seed; a gap costs a stale panel nobody is told about.
 */
const DEFAULT_SINCE_MINUTES = 16;

/**
 * Seeds are network-bound and the upstream APIs are rate-limited. Four at a
 * time refilled all 52 scripts in about twenty minutes on 2026-08-07.
 */
const DEFAULT_CONCURRENCY = 4;

/** No single seed may hold the run open. The slowest full-refill script took
 * a little over four minutes; ten is generous and still bounded. */
const SCRIPT_TIMEOUT_MS = 10 * 60_000;

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} needs a positive number, got ${process.argv[i + 1]}`);
  }
  return value;
}

type Result = {
  script: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  seconds: number;
  records: number | null;
  timedOut: boolean;
};

function runScript(script: string): Promise<Result> {
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn('node', [script], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      // The seeds print progress freely; keep only the tail so a chatty script
      // cannot exhaust memory in a long run.
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SCRIPT_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`${script}: could not start — ${err.message}`);
      resolveRun({ script, code: null, signal: null, seconds: 0, records: null, timedOut });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Bundle scripts print one `seed_complete` per section; sum them.
      const counts = [...output.matchAll(/"recordCount":\s*(\d+)/g)].map((m) => Number(m[1]));
      const seconds = (Date.now() - started) / 1000;
      const records = counts.length ? counts.reduce((a, b) => a + b, 0) : null;
      const status = code === 0 ? 'ok' : timedOut ? 'TIMEOUT' : `FAILED rc=${code ?? signal}`;
      console.log(
        `${status.padEnd(12)} ${script.padEnd(46)} ${seconds.toFixed(1)}s` +
          (records === null ? '' : ` ${records} records`),
      );
      if (code !== 0) console.log(output.split('\n').slice(-12).join('\n'));
      resolveRun({ script, code, signal, seconds, records, timedOut });
    });
  });
}

async function runAll(scripts: string[], concurrency: number): Promise<Result[]> {
  const queue = [...scripts];
  const results: Result[] = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let script = queue.shift(); script; script = queue.shift()) {
      results.push(await runScript(script));
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const sinceMinutes = flag('since-minutes', DEFAULT_SINCE_MINUTES);
  if (sinceMinutes > MAX_WINDOW_MINUTES) {
    throw new Error(`--since-minutes ${sinceMinutes} exceeds the ${MAX_WINDOW_MINUTES} cap`);
  }
  const concurrency = flag('concurrency', DEFAULT_CONCURRENCY);
  const to = Date.now();
  const from = to - sinceMinutes * 60_000;
  const scripts = dueScripts(from, to);

  console.log(
    `window ${new Date(from).toISOString()} → ${new Date(to).toISOString()} ` +
      `(${sinceMinutes}m): ${scripts.length} scripts due`,
  );
  if (!scripts.length) return;
  if (process.argv.includes('--dry-run')) {
    for (const script of scripts) console.log(`  would run ${script}`);
    return;
  }

  const results = await runAll(scripts, concurrency);
  const failed = results.filter((r) => r.code !== 0);
  const records = results.reduce((sum, r) => sum + (r.records ?? 0), 0);
  console.log(
    `\n${results.length} run · ${results.length - failed.length} ok · ` +
      `${failed.length} failed · ${records} records`,
  );
  if (failed.length) {
    // Loud on purpose. A fallback that swallows failures is a fallback nobody
    // knows has stopped working, which is how the original outage stayed
    // invisible for an hour.
    console.error(`failed: ${failed.map((r) => r.script).join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
