/**
 * The actual wrangler `main` entrypoint.
 *
 * `worker/index.ts` holds the routing Worker's default export and is
 * imported directly, under a plain Node environment, by
 * tests/worker/index.test.mts (78 tests, vitest.worker.config.mts). A
 * Durable Object class can only import `cloudflare:workers` — a module that
 * only exists inside workerd/Miniflare — and a real ES module import runs
 * at load time no matter whether the imported binding is used, so adding
 * `export { CounterDO } from './counters/counter-do'` directly to
 * worker/index.ts (as the task brief originally specified) would make plain
 * `import worker from '../../worker/index'` throw "Cannot find package
 * 'cloudflare:workers'" the instant Node evaluates it, breaking that entire
 * suite.
 *
 * wrangler needs every bound Durable Object class reachable as a named
 * export of the single script named by `main` in wrangler.jsonc — there is
 * no way around that for a single-script Worker. This file is that script:
 * it re-exports the routing Worker's default fetch handler unchanged and
 * adds the one export wrangler needs for the `COUNTER` binding, without
 * touching the file the existing routing tests import.
 */
import { getContainer } from '@cloudflare/containers';
import worker from './index';
import { SeedContainer } from './containers/seed-container';
import { handleScheduled } from './seeds/scheduled';
import { seedEnvVars } from './seeds/env';

type SeedEnv = Record<string, unknown> & {
  SEED_CONTAINER: DurableObjectNamespace<SeedContainer>;
};

/**
 * The container call lives here, not in worker/seeds/scheduled.ts:
 * @cloudflare/containers imports `cloudflare:workers`, and only this file is
 * safe to hold such an import — the Node test suites never load it.
 *
 * One instance per script path, so two scripts sharing a cron expression
 * never land in the same instance. enableInternet is required: every seed
 * fetches an external source. envVars is required too: a container inherits
 * nothing from the Worker, so without it every seed reads an empty
 * process.env and writes nothing.
 */
export default {
  fetch: worker.fetch,
  scheduled: (event: { cron: string }, env: SeedEnv) =>
    handleScheduled(event, async (script) => {
      await getContainer(env.SEED_CONTAINER, script).start({
        entrypoint: ['node', script],
        enableInternet: true,
        envVars: seedEnvVars(env),
      });
    }),
};

export { CounterDO } from './counters/counter-do';
export { SeedContainer } from './containers/seed-container';
export { AisRelayDO } from './ais/relay-do';
