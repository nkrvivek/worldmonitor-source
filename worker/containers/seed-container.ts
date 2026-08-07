import { Container } from '@cloudflare/containers';

/**
 * One-shot seed job runner.
 *
 * Every instance is started with an explicit entrypoint by
 * worker/seeds/scheduled.ts and exits when the seed script exits, so there is
 * no long-lived server and no defaultPort. sleepAfter is the ceiling for a
 * single seed run; _bundle-runner.mjs budgets its sections in minutes.
 */
export class SeedContainer extends Container {
  sleepAfter = '15m';
}
