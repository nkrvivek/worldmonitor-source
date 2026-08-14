import type { GatewayCtx } from '../../server/gateway';
// @ts-expect-error — JS module, no declaration file
import bootstrapHandler from '../../api/bootstrap.js';

export const BOOTSTRAP_PATH = '/api/bootstrap';

/**
 * The one call that fills the front end. Ten-plus modules under src/ read it
 * (data-loader, country-intel, insights-loader, the panels), so while it 404ed
 * the shell rendered and every panel stayed empty.
 *
 * A trailing slash counts. worker/index.ts strips one only further down the
 * chain, after this branch has already had its say.
 */
export function isBootstrapPath(pathname: string): boolean {
  return pathname === BOOTSTRAP_PATH || pathname === `${BOOTSTRAP_PATH}/`;
}

/**
 * api/bootstrap.js already exports a web-standard `(Request, ctx) => Response`
 * handler and reads its config from process.env, which nodejs_compat populates
 * from vars and secrets. So this is a call, not a rewrite -- the 586-line
 * handler and its ~1,600 lines of helpers move unchanged.
 *
 * Its R2 shadow probe is the one Vercel-shaped thing left inside, and it stays
 * dormant here: shouldMeasureBootstrapR2Shadow() requires VERCEL_ENV to equal
 * 'production', and no such var exists on this Worker. Serving reads Upstash,
 * which the Worker's own secrets already name.
 */
export async function handleBootstrap(request: Request, ctx?: GatewayCtx): Promise<Response> {
  return bootstrapHandler(request, ctx);
}
