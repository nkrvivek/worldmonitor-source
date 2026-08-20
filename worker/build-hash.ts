/**
 * The build stamp behind __BUILD_HASH__ and the stale-bundle reload check.
 *
 * Each host names this differently, and an unset value degrades to 'dev' —
 * which makes every build look identical and silently disables the reload
 * check. Read every host we build on.
 */
export function resolveBuildHash(env: Record<string, string | undefined>): string {
  return (
    env.WORKERS_CI_COMMIT_SHA ||
    env.CF_PAGES_COMMIT_SHA ||
    env.VERCEL_GIT_COMMIT_SHA ||
    'dev'
  );
}
