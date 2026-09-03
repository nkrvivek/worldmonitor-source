/**
 * Where a Stripe checkout is allowed to send the customer back to.
 *
 * `returnUrl` arrives from the browser, so an unchecked value is an open
 * redirect on a page the customer reaches mid-payment. The guard is an
 * allow-list of origins.
 *
 * Upstream hard-coded its own apex plus seven subdomains in that list, and
 * defaulted to its apex when SITE_URL was unset. This fork serves one host and
 * controls no worldmonitor.app name, so both meant our checkout could hand a
 * paying customer to somebody else's site. The list now derives from SITE_URL,
 * with ALLOWED_RETURN_ORIGINS as the escape hatch for a second host (staging,
 * a preview deployment) as a comma-separated list of origins.
 */
import { ConvexError } from "convex/values";

/** Used only when SITE_URL is unset. Prod sets it; dev deployments may not. */
export const DEFAULT_SITE_URL = "https://worldmonitor.sibt.ai";

export function resolveSiteUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SITE_URL ?? DEFAULT_SITE_URL;
}

export function allowedReturnOrigins(
  siteUrl: string,
  extra?: string,
): ReadonlySet<string> {
  const origins = new Set<string>([new URL(siteUrl).origin]);
  for (const entry of (extra ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // A typo in the env list must not take checkout down; the entry simply
      // does not join the allow-list, and the returnUrl using it is rejected.
    }
  }
  return origins;
}

export function resolveReturnUrl(
  rawReturnUrl: string | undefined,
  siteUrl: string,
  extra?: string,
): string {
  if (!rawReturnUrl) return siteUrl;

  let parsed: URL;
  try {
    parsed = new URL(rawReturnUrl);
  } catch {
    throw new ConvexError("Invalid returnUrl: must be a valid absolute URL");
  }

  if (!allowedReturnOrigins(siteUrl, extra).has(parsed.origin)) {
    throw new ConvexError("Invalid returnUrl: must use a trusted origin");
  }
  return parsed.toString();
}
