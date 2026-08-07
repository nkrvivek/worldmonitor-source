import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { FALLBACK_PRICES, PUBLIC_PRODUCT_FACTS } from './_product-catalog.generated.js';

const PRICED_LOOKUP_KEYS = Object.keys(FALLBACK_PRICES);

/** Stands in for Stripe's `GET /v1/prices` list response. */
function stripePriceList(lookupKeys, { unitAmountOverride } = {}) {
  return {
    object: 'list',
    data: lookupKeys.map((key) => ({
      id: `price_${key}`,
      object: 'price',
      active: true,
      lookup_key: key,
      currency: 'usd',
      unit_amount: unitAmountOverride === undefined ? FALLBACK_PRICES[key] + 100 : unitAmountOverride,
    })),
  };
}

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function importHandler({ relaySecret, upstash = false, stripeKey = null }) {
  if (upstash) {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  } else {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  if (stripeKey == null) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = stripeKey;
  }
  if (relaySecret == null) {
    delete process.env.RELAY_SHARED_SECRET;
  } else {
    process.env.RELAY_SHARED_SECRET = relaySecret;
  }
  const mod = await import(`./product-catalog.js?test=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function getRequest() {
  return new Request('https://api.worldmonitor.app/api/product-catalog', {
    method: 'GET',
  });
}

function deleteRequest(authHeader) {
  const headers = new Headers();
  if (authHeader != null) headers.set('Authorization', authHeader);
  return new Request('https://api.worldmonitor.app/api/product-catalog', {
    method: 'DELETE',
    headers,
  });
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreEnv();
});

test('DELETE purge accepts only the exact relay bearer secret', async () => {
  const handler = await importHandler({ relaySecret: 'relay-secret-with-distinct-length' });

  const accepted = await handler(deleteRequest('Bearer relay-secret-with-distinct-length'));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { purged: true });

  const prefixOnly = await handler(deleteRequest('Bearer relay-secret-with-distinct'));
  assert.equal(prefixOnly.status, 401);

  const longerMismatch = await handler(deleteRequest('Bearer relay-secret-with-distinct-length-extra'));
  assert.equal(longerMismatch.status, 401);
});

test('DELETE purge fails closed when RELAY_SHARED_SECRET is missing', async () => {
  const handler = await importHandler({ relaySecret: null });

  const missingSecret = await handler(deleteRequest('Bearer '));
  assert.equal(missingSecret.status, 401);

  const noAuth = await handler(deleteRequest(null));
  assert.equal(noAuth.status, 401);
});

test('GET fallback publishes generated lifecycle, pricing, and capability facts', async () => {
  const handler = await importHandler({ relaySecret: null });

  const response = await handler(getRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-product-catalog-source'), 'fallback');

  const body = await response.json();
  assert.equal(body.product.lifecycle, 'launched');
  assert.equal(body.product.pricingUrl, 'https://worldmonitor.sibt.ai/pro#pricing');
  assert.equal(body.currency, 'USD');
  assert.equal(body.capabilities.mcpTools, PUBLIC_PRODUCT_FACTS.capabilities.mcpTools);
  const proMonthly = PUBLIC_PRODUCT_FACTS.plans.find((plan) => plan.planKey === 'pro_monthly');
  const proAnnual = PUBLIC_PRODUCT_FACTS.plans.find((plan) => plan.planKey === 'pro_annual');
  assert.ok(body.plans.some((plan) => (
    plan.planKey === 'pro_monthly'
    && plan.price === proMonthly.price
    && plan.billingDuration === 'P1M'
  )));
  assert.ok(body.tiers.some((tier) => (
    tier.name === 'Pro'
    && tier.monthlyPrice === proMonthly.price
    && tier.annualPrice === proAnnual.price
  )));
});

test('GET asks Stripe for every catalog lookup key and serves the live prices', async () => {
  let requestedUrl = null;
  let requestedHeaders = null;
  globalThis.fetch = async (url, init) => {
    requestedUrl = String(url);
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify(stripePriceList(PRICED_LOOKUP_KEYS)));
  };
  const handler = await importHandler({ relaySecret: null, stripeKey: 'sk_test_catalog' });

  const response = await handler(getRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-product-catalog-source'), 'stripe');

  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, 'https://api.stripe.com/v1/prices');
  assert.equal(url.searchParams.get('active'), 'true');
  assert.deepEqual(url.searchParams.getAll('lookup_keys[]').sort(), [
    'wm_api_annual',
    'wm_api_business_annual',
    'wm_api_business_monthly',
    'wm_api_monthly',
    'wm_enterprise',
    'wm_pro_annual',
    'wm_pro_monthly',
  ]);
  assert.equal(requestedHeaders.get('authorization'), 'Bearer sk_test_catalog');
  assert.equal(requestedHeaders.get('stripe-version'), '2026-07-29.dahlia');

  const body = await response.json();
  assert.equal(body.priceSource, 'stripe');
  const pro = body.tiers.find((tier) => tier.name === 'Pro');
  assert.equal(pro.monthlyPrice, (FALLBACK_PRICES.wm_pro_monthly + 100) / 100);
  assert.equal(pro.annualPrice, (FALLBACK_PRICES.wm_pro_annual + 100) / 100);
});

test('GET reports a partial read when Stripe knows only some of the plans', async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify(stripePriceList(['wm_pro_monthly', 'wm_pro_annual'])),
  );
  const handler = await importHandler({ relaySecret: null, stripeKey: 'sk_test_catalog' });

  const response = await handler(getRequest());
  assert.equal(response.headers.get('x-product-catalog-source'), 'partial');

  const body = await response.json();
  // Header and body must agree — a partial read stamped as fully live once
  // made probes read a degraded response as healthy.
  assert.equal(body.priceSource, 'partial');
  const pro = body.tiers.find((tier) => tier.name === 'Pro');
  assert.equal(pro.monthlyPrice, (FALLBACK_PRICES.wm_pro_monthly + 100) / 100);
  const apiTier = body.tiers.find((tier) => tier.monthlyProductId === 'wm_api_monthly');
  assert.equal(apiTier.monthlyPrice, FALLBACK_PRICES.wm_api_monthly / 100);
});

test('GET falls back to static prices when Stripe rejects the read', async () => {
  globalThis.fetch = async () => new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 });
  const handler = await importHandler({ relaySecret: null, stripeKey: 'sk_test_bad' });

  const response = await handler(getRequest());
  assert.equal(response.headers.get('x-product-catalog-source'), 'fallback');

  const body = await response.json();
  assert.equal(body.priceSource, 'fallback');
  const pro = body.tiers.find((tier) => tier.name === 'Pro');
  assert.equal(pro.monthlyPrice, FALLBACK_PRICES.wm_pro_monthly / 100);
});

test('GET does not publish a price of zero when Stripe returns no unit amount', async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify(stripePriceList(PRICED_LOOKUP_KEYS, { unitAmountOverride: null })),
  );
  const handler = await importHandler({ relaySecret: null, stripeKey: 'sk_test_catalog' });

  const response = await handler(getRequest());
  assert.equal(response.headers.get('x-product-catalog-source'), 'fallback');

  const body = await response.json();
  const pro = body.tiers.find((tier) => tier.name === 'Pro');
  assert.equal(pro.monthlyPrice, FALLBACK_PRICES.wm_pro_monthly / 100);
});

test('GET reads the same Redis key the seed loop writes', async () => {
  // The reader sat on `product-catalog:v2` after the writers moved to `:v3`,
  // so the cache branch never hit and every request re-read the provider.
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ result: null }));
  };
  const handler = await importHandler({ relaySecret: null, upstash: true });
  await handler(getRequest());

  const writerKey = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8')
    .match(/PRICE_REDIS_KEY = '(product-catalog:[^']+)'/)?.[1];
  assert.ok(writerKey, 'could not read the seed loop key out of scripts/ais-relay.cjs');
  assert.equal(requestedUrl, `https://upstash.example/get/${encodeURIComponent(writerKey)}`);
});

test('GET cache cannot override generated public lifecycle and capability facts', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: JSON.stringify({
      product: { lifecycle: 'waitlist', pricingUrl: '/stale' },
      currency: 'EUR',
      plans: [],
      capabilities: { mcpTools: 1 },
      tiers: [{ name: 'Cached tier' }],
      fetchedAt: 123,
    }),
  }));
  const handler = await importHandler({ relaySecret: null, upstash: true });

  const response = await handler(getRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-product-catalog-source'), 'cache');

  const body = await response.json();
  assert.equal(body.product.lifecycle, PUBLIC_PRODUCT_FACTS.product.lifecycle);
  assert.equal(body.product.pricingUrl, PUBLIC_PRODUCT_FACTS.product.pricingUrl);
  assert.equal(body.currency, PUBLIC_PRODUCT_FACTS.currency);
  assert.deepEqual(body.plans, PUBLIC_PRODUCT_FACTS.plans);
  assert.equal(body.capabilities.mcpTools, PUBLIC_PRODUCT_FACTS.capabilities.mcpTools);
  assert.deepEqual(body.tiers, [{ name: 'Cached tier' }]);
});
