/**
 * Open-redirect guard for the two provider-hosted pages we navigate buyers to:
 * Stripe Checkout and the Stripe billing portal (#4449).
 *
 * Both URLs come back from the server and both are handed straight to
 * `location.assign` / `window.open`. Validating them here means a compromised
 * or malformed response can never navigate a buyer to a `javascript:` URL, an
 * `http:` downgrade, or a third-party host.
 *
 * Each host list holds one host, not two. Dodo had a separate
 * `test.checkout.` origin for test mode; Stripe serves test and live sessions
 * from the same host and tells them apart by the session id, so there is no
 * second entry to add and no environment switch to get wrong.
 *
 * Extracted to its own dependency-free module so it can be unit-tested without
 * pulling the full checkout service graph (browser globals, Convex, Sentry).
 */
export const HOSTED_CHECKOUT_HOSTS = new Set(['checkout.stripe.com']);

export const BILLING_PORTAL_HOSTS = new Set(['billing.stripe.com']);

function safeUrlFromHosts(raw: unknown, hosts: ReadonlySet<string>): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (!hosts.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function safeHostedCheckoutUrl(raw: unknown): string | null {
  return safeUrlFromHosts(raw, HOSTED_CHECKOUT_HOSTS);
}

export function safeBillingPortalUrl(raw: unknown): string | null {
  return safeUrlFromHosts(raw, BILLING_PORTAL_HOSTS);
}
