/**
 * Where the payments gateways send their relay calls, read at call time.
 *
 * Both gateways used to pin these at module scope. That was safe on Vercel,
 * where each function is its own process, and is a hazard in the Worker: a
 * module evaluated before the binding is visible pins the empty string for the
 * life of the isolate, and every checkout after that returns 503 with nothing
 * in the logs to say why. Every other reader of CONVEX_SITE_URL in this repo
 * (server/_shared/entitlement-check.ts, user-api-key.ts, pro-mcp-token.ts,
 * intel-history-client.ts) already reads it inside a function; these two were
 * the outliers.
 *
 * Lives under api/ and not server/_shared/ on purpose: scripts/seed-image-tag.sh
 * hashes server/, so a file there moves the seed container image tag and forces
 * a re-pin of wrangler.jsonc. api/ is not on that path.
 */

/** Convex's HTTP-action origin. Falls back to deriving it from CONVEX_URL. */
export function convexSiteUrl(): string {
  return (
    process.env.CONVEX_SITE_URL ??
    (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site')
  );
}

/** The secret that proves a relay caller is one of ours. */
export function relaySharedSecret(): string {
  return process.env.RELAY_SHARED_SECRET ?? '';
}
