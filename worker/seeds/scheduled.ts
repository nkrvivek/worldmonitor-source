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
 * Swallowed is not the same as unrecorded, though, so the caller also gets
 * `onStartError` — see worker/seeds/run-record.ts for why a console.error on
 * its own left a refused start looking exactly like a cron that never fired.
 */
type ScheduledEventLike = { readonly cron: string };

/** Starts one seed script in its own container instance. */
export type SeedStarter = (script: string) => Promise<void>;

/** Records one seed that never started. Must not throw; see handleScheduled. */
export type SeedStartErrorHandler = (script: string, err: unknown) => Promise<void>;

export async function handleScheduled(
  event: ScheduledEventLike,
  startSeed: SeedStarter,
  onStartError?: SeedStartErrorHandler,
): Promise<void> {
  const scripts = scriptsForCron(event.cron);

  await Promise.all(
    scripts.map(async (script) => {
      try {
        await startSeed(script);
      } catch (err) {
        console.error(`seed ${script} failed to start:`, err);
        // Recording the failure is best effort on top of a failure we are
        // already tolerating. If the recorder is down too, the sibling seeds
        // still have to run.
        try {
          await onStartError?.(script, err);
        } catch (recordErr) {
          console.error(`seed ${script} start-failure record failed:`, recordErr);
        }
      }
    }),
  );
}
