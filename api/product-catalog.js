/**
 * Product catalog API endpoint.
 *
 * Fetches product prices from Stripe and returns a structured tier view
 * model for the /pro pricing page. Cached in Redis with configurable TTL.
 *
 * GET /api/product-catalog → { product, currency, plans, capabilities, tiers, fetchedAt, cachedUntil }
 * DELETE /api/product-catalog → purge cache (requires RELAY_SHARED_SECRET)
 */

// @ts-check

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module
import { timingSafeEqualSecret } from './_crypto.js';
// @ts-expect-error — generated JS module
import {
  FALLBACK_PRICES,
  PRODUCT_CATALOG as CATALOG,
  PUBLIC_PRODUCT_FACTS,
  PUBLIC_TIER_GROUPS,
  TIER_CONFIG,
} from './_product-catalog.generated.js';
// @ts-expect-error — JS module
import { unwrapEnvelope } from './_seed-envelope.js';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';

// Must match the key the seed loop writes (scripts/ais-relay.cjs) and the key
// the probe and health check watch (api/seed-contract-probe.ts, api/health.js).
// This read was left on `:v2` after the writers moved to `:v3`, so the cache
// branch could never hit and every request fell through to the live read.
const CACHE_KEY = 'product-catalog:v3';
const CACHE_TTL = 3600; // 1 hour

// Pinned to match convex/lib/stripe.ts:STRIPE_API_VERSION. An unpinned call
// follows whatever the account default is, so a dashboard-side upgrade could
// change the response shape under us.
const STRIPE_API_VERSION = '2026-07-29.dahlia';

function json(body, status, cors, cacheControl, source) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
      // Signals which code-path served the response so operators + the
      // seed-contract probe can distinguish cache hits from live/fallback reads.
      // Without this header a green probe would not prove the cached-reader
      // path is healthy — it could be silently falling through to fallback.
      ...(source ? { 'X-Product-Catalog-Source': source } : {}),
      ...cors,
    },
  });
}

function withPublicFacts(payload) {
  return { ...payload, ...PUBLIC_PRODUCT_FACTS };
}

async function getFromCache() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(CACHE_KEY)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const { result } = await res.json();
    if (!result) return null;
    // Envelope-aware: ais-relay writes this key as {_seed, data}
    // (PR #3097). Return the bare payload so clients see the legacy
    // {tiers, fetchedAt, cachedUntil, priceSource} shape. Pre-contract bare
    // values pass through unchanged.
    return unwrapEnvelope(JSON.parse(result)).data;
  } catch { return null; }
}

async function setCache(data) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', CACHE_KEY, JSON.stringify(data), 'EX', String(CACHE_TTL)]),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* non-fatal */ }
}

async function purgeCache() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['DEL', CACHE_KEY]),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* non-fatal */ }
}

/**
 * Reads live prices from Stripe, keyed by lookup key.
 *
 * The catalog keys ARE the Stripe lookup keys (`wm_pro_monthly`, …), so one
 * list call covers every plan. Lookup keys and not price ids on purpose: a
 * price id changes whenever a price is replaced, and this file would then
 * quietly serve fallback numbers.
 *
 * Returns a map of lookup key → price. A key Stripe does not know about is
 * simply absent, which the caller reads as a partial answer.
 */
async function fetchPricesFromStripe() {
  const lookupKeys = Object.keys(CATALOG);
  const params = new URLSearchParams({ active: 'true', limit: '100' });
  for (const key of lookupKeys) params.append('lookup_keys[]', key);

  let payload;
  try {
    const res = await fetch(`https://api.stripe.com/v1/prices?${params}`, {
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Stripe-Version': STRIPE_API_VERSION,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    console.warn('[product-catalog] Stripe price fetch failed:', err?.message);
    return {};
  }

  const prices = {};
  for (const price of Array.isArray(payload?.data) ? payload.data : []) {
    // unit_amount is null on tiered and metered prices. Treating that as 0
    // would publish a free plan, so drop it and let the fallback answer.
    if (!price?.lookup_key || typeof price.unit_amount !== 'number') continue;
    prices[price.lookup_key] = {
      priceCents: price.unit_amount,
      currency: (price.currency ?? 'usd').toUpperCase(),
      name: price.nickname ?? price.lookup_key,
    };
  }
  return prices;
}

function buildTiers(livePrices) {
  const tiers = [];

  for (const group of PUBLIC_TIER_GROUPS) {
    const config = TIER_CONFIG[group];
    if (!config) continue;

    if (group === 'free') {
      tiers.push({ ...config, price: 0, period: 'forever' });
      continue;
    }

    if (group === 'enterprise') {
      tiers.push({ ...config, price: null });
      continue;
    }

    // Find monthly and annual products for this tier group
    const monthlyEntry = Object.entries(CATALOG).find(([, v]) => v.tierGroup === group && v.billingPeriod === 'monthly');
    const annualEntry = Object.entries(CATALOG).find(([, v]) => v.tierGroup === group && v.billingPeriod === 'annual');

    const tier = { ...config };

    if (monthlyEntry) {
      const [monthlyId] = monthlyEntry;
      const monthlyPrice = livePrices[monthlyId];
      if (monthlyPrice) {
        tier.monthlyPrice = monthlyPrice.priceCents / 100;
      } else if (FALLBACK_PRICES[monthlyId] != null) {
        tier.monthlyPrice = FALLBACK_PRICES[monthlyId] / 100;
        console.warn(`[product-catalog] FALLBACK price for ${monthlyId} ($${tier.monthlyPrice}) — no live Stripe price`);
      }
      tier.monthlyProductId = monthlyId;
    }

    if (annualEntry) {
      const [annualId] = annualEntry;
      const annualPrice = livePrices[annualId];
      if (annualPrice) {
        tier.annualPrice = annualPrice.priceCents / 100;
      } else if (FALLBACK_PRICES[annualId] != null) {
        tier.annualPrice = FALLBACK_PRICES[annualId] / 100;
        console.warn(`[product-catalog] FALLBACK price for ${annualId} ($${tier.annualPrice}) — no live Stripe price`);
      }
      tier.annualProductId = annualId;
    }

    tiers.push(tier);
  }

  return tiers;
}

export default async function handler(req) {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
  }

  // DELETE = purge cache (authenticated)
  if (req.method === 'DELETE') {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!RELAY_SECRET || !(await timingSafeEqualSecret(authHeader, `Bearer ${RELAY_SECRET}`))) {
      return json({ error: 'Unauthorized' }, 401, cors);
    }
    await purgeCache();
    return json({ purged: true }, 200, cors);
  }

  // GET = return cached or fresh catalog
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, cors);
  }

  // Read from Redis (populated by the ais-relay seed loop)
  const cached = await getFromCache();
  if (cached) {
    return json(withPublicFacts(cached), 200, cors, 'public, max-age=300, s-maxage=600, stale-while-revalidate=300', 'cache');
  }

  // Redis empty (purged or the seed loop hasn't run). Read Stripe directly as
  // a backup. If that fails too we fall back to the static prices below.
  if (STRIPE_SECRET_KEY) {
    const livePrices = await fetchPricesFromStripe();
    const pricedPublicIds = Object.entries(CATALOG)
      .filter(([, v]) => PUBLIC_TIER_GROUPS.includes(v.tierGroup) && v.tierGroup !== 'free' && v.tierGroup !== 'enterprise')
      .map(([id]) => id);
    const livePriceCount = pricedPublicIds.filter(id => livePrices[id]).length;
    if (livePriceCount > 0) {
      const priceSource = livePriceCount === pricedPublicIds.length ? 'stripe' : 'partial';
      const tiers = buildTiers(livePrices);
      const now = Date.now();
      const result = withPublicFacts({ tiers, fetchedAt: now, cachedUntil: now + CACHE_TTL * 1000, priceSource });
      // Don't write to Redis — the seed loop owns that key with its longer TTL.
      // Return with a short cache so the next seed cycle repopulates properly.
      // Header must carry the SAME source as the body: a partial provider read
      // stamped 'stripe' here made probes read a degraded response as fully live.
      return json(result, 200, cors, 'public, max-age=60, s-maxage=60', priceSource);
    }
  }

  // All sources failed. Return fallback with short cache.
  const tiers = buildTiers({});
  const now = Date.now();
  return json(withPublicFacts({ tiers, fetchedAt: now, cachedUntil: now + 60_000, priceSource: 'fallback' }), 200, cors, 'public, max-age=60, s-maxage=60', 'fallback');
}
