/**
 * Stripe checkout-session creation via the official SDK ("stripe").
 *
 * HISTORY: this seam used to call Dodo Payments (lib/dodo.ts, removed in the
 * same change). Two facts from that history still bind, because the ladder
 * they protect is unchanged:
 *   (a) the SDK is pinned to zero network retries, so the bounded ladder in
 *       payments/checkoutRateLimit.ts owns ALL retry policy. Without the pin,
 *       one ladder attempt becomes several provider requests and the ladder's
 *       wall-clock budget stops meaning anything.
 *   (b) each attempt carries its own timeout, because the ladder can only
 *       enforce its deadline BETWEEN attempts.
 * Stripe spells the first option `maxNetworkRetries`, not `maxRetries`.
 *
 * RUNTIME: no convex file declares "use node", so this runs in Convex's V8
 * runtime, which has fetch and no node:http. Stripe.createFetchHttpClient()
 * is what makes the SDK use fetch instead.
 *
 * LOOKUP KEYS, NOT PRICE IDS: the catalog stores a price's `lookup_key` in
 * CatalogEntry.providerPriceId (see config/productCatalog.ts) because price
 * ids differ between test and live mode. Checkout resolves the key to a price
 * id here, once per isolate, BEFORE entering the retry ladder — resolving it
 * inside an attempt would make one attempt two provider requests.
 *
 * DUAL SDK NOTE: billing.ts builds its own client for portal / subscription
 * calls; webhook signature verification lives in payments/webhookHandlers.ts.
 * This module is only the checkout-session seam (checkout.ts mocks it in
 * tests via vi.mock).
 *
 * Config is read lazily (on first use) so a missing env var fails at the
 * action boundary with a clear error instead of at import time.
 * Canonical env var: STRIPE_SECRET_KEY (set in the Convex dashboard).
 */

import Stripe from "stripe";

/**
 * Per-attempt cap on one provider round-trip. The retry ladder makes up to
 * CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS attempts inside an 8s wall-clock budget
 * (see payments/checkoutRateLimit.ts), so each attempt must be individually
 * bounded or a hung/slow provider call would blow through the budget the
 * deadline check can only enforce BETWEEN attempts.
 */
export const CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS = 3_500;

/**
 * Pinned so an SDK upgrade cannot change response shapes underneath us. The
 * SDK's own default is whatever version it shipped with; naming it here makes
 * the upgrade a deliberate edit.
 */
export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

export type CheckoutSessionPayload = Stripe.Checkout.SessionCreateParams;

export interface CheckoutSessionResult {
  checkout_url: string;
}

export interface StripeClientOptions {
  apiKey: string;
  config: Stripe.StripeConfig;
}

/**
 * Client options for the checkout-session client, exported as a pure function
 * so tests can assert the retry contract without network access.
 * maxNetworkRetries: 0 is load-bearing — see the module header; deleting it
 * reintroduces nested provider retries under the action ladder.
 */
export function buildCheckoutClientOptions(env: {
  STRIPE_SECRET_KEY?: string;
}): StripeClientOptions {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error(
      "[stripe] STRIPE_SECRET_KEY is not set. " +
        "Set it in the Convex dashboard environment variables.",
    );
  }
  return {
    apiKey: env.STRIPE_SECRET_KEY,
    config: {
      apiVersion: STRIPE_API_VERSION,
      httpClient: Stripe.createFetchHttpClient(),
      maxNetworkRetries: 0,
      timeout: CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS,
    },
  };
}

export function createStripeClient(env: {
  STRIPE_SECRET_KEY?: string;
}): Stripe {
  const { apiKey, config } = buildCheckoutClientOptions(env);
  return new Stripe(apiKey, config);
}

/**
 * lookup_key → price id, memoized for the life of the isolate. A price's
 * lookup key is stable and its id never changes, so a hit can be reused; a
 * miss is not cached, because the fix (create the price) happens outside this
 * process and the next call should see it.
 */
const priceIdByLookupKey = new Map<string, string>();

/** Test seam: the memo outlives a single test otherwise. */
export function resetCheckoutPriceCache(): void {
  priceIdByLookupKey.clear();
}

export async function resolveCheckoutPriceId(
  lookupKey: string,
  client?: Stripe,
): Promise<string> {
  const cached = priceIdByLookupKey.get(lookupKey);
  if (cached) return cached;

  const stripe = client ?? createStripeClient(process.env);
  const prices = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });
  const priceId = prices.data[0]?.id;
  if (!priceId) {
    throw new Error(
      `No active Stripe price with lookup_key "${lookupKey}". ` +
        "Run scripts/stripe-sync-catalog to create it.",
    );
  }
  priceIdByLookupKey.set(lookupKey, priceId);
  return priceId;
}

/**
 * Resolve a promotion code (the string a buyer types) to its promotion-code
 * id. Returns null when nothing active matches, so the caller can fall back to
 * letting Stripe Checkout collect a code instead of failing the purchase.
 */
export async function resolvePromotionCodeId(
  code: string,
  client?: Stripe,
): Promise<string | null> {
  const stripe = client ?? createStripeClient(process.env);
  const promos = await stripe.promotionCodes.list({
    code,
    active: true,
    limit: 1,
  });
  return promos.data[0]?.id ?? null;
}

/**
 * Create one checkout session — exactly one HTTP request (no SDK-internal
 * retries). Throws the SDK's typed StripeError on failure (statusCode 429 for
 * rate limits, classified by payments/checkoutRateLimit.ts).
 */
export async function createStripeCheckoutSession(
  payload: CheckoutSessionPayload,
): Promise<CheckoutSessionResult> {
  const client = createStripeClient(process.env);
  const session = await client.checkout.sessions.create(payload);
  if (!session.url) {
    // Session created but no redirect URL — surface as a hard (non-429)
    // failure on the existing error channel rather than returning a dead link.
    throw new Error(`Stripe checkout session ${session.id} has no url`);
  }
  return { checkout_url: session.url };
}
