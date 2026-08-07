import type { GatewayCtx } from '../../server/gateway';
// @ts-expect-error — JS module, no declaration file
import healthHandler from '../../api/health.js';

export const HEALTH_PATH = '/api/health';

/**
 * The status endpoint, in the Worker.
 *
 * `/api/health?compact=1` is what this site advertises to the outside world as
 * its status URL — the `rel="status"` entry in the Link header (vercel.json)
 * and the hint the keyed form returns on a 401. It was never routed, so every
 * caller that followed that advertisement hit the UPSTREAM_API_ORIGIN proxy and
 * got nothing back. The seed freshness monitor is one of those callers, which
 * is why .github/workflows/seed-freshness-monitor.yml has been off.
 *
 * Careful with the prefix: worker/routes/domains.ts already serves the sebuf
 * service under `/api/health/v1/`, and it is matched earlier in worker/index.ts.
 * This route matches the bare path only, so the two cannot shadow each other.
 *
 * Called, not rewritten: api/health.js already exports a web-standard
 * `(Request, ctx) => Response` handler and reads Upstash credentials from
 * process.env per request, which nodejs_compat fills from the Worker's own
 * secrets. Its two module-scope reads are VERCEL_ENV and VERCEL_GIT_COMMIT_SHA,
 * neither of which exists here — absent, they resolve to the production Redis
 * key, which is the right one for this deployment.
 *
 * Cost: the compact path a browser polls reads one memoized verdict from Redis.
 * Only the once-a-minute sweep behind it walks the full key set, and it
 * pipelines those reads rather than issuing one subrequest each.
 */
export function isHealthPath(pathname: string): boolean {
  return pathname === HEALTH_PATH || pathname === `${HEALTH_PATH}/`;
}

export async function handleHealth(request: Request, ctx?: GatewayCtx): Promise<Response> {
  return healthHandler(request, ctx);
}
