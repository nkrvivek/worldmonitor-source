import { scriptsForCron } from './registry';

/**
 * Cron Trigger dispatch, kept free of Cloudflare imports.
 *
 * @cloudflare/containers imports `cloudflare:workers`, which cannot resolve
 * under plain Node — the same constraint that keeps CounterDO out of
 * worker/index.ts. So the container call is injected by worker/entry.ts and
 * this file stays loadable by tests/worker/seed-scheduled.test.mts.
 *
 * Failures are logged and swallowed per script: one dead seed must not stop
 * its siblings, which is what Railway's per-service isolation gave us free.
 */
type ScheduledEventLike = { readonly cron: string };

/** Starts one seed script in its own container instance. */
export type SeedStarter = (script: string) => Promise<void>;

export async function handleScheduled(
  event: ScheduledEventLike,
  startSeed: SeedStarter,
): Promise<void> {
  const scripts = scriptsForCron(event.cron);

  await Promise.all(
    scripts.map(async (script) => {
      try {
        await startSeed(script);
      } catch (err) {
        console.error(`seed ${script} failed to start:`, err);
      }
    }),
  );
}
