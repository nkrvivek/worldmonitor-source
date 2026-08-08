#!/usr/bin/env node
/**
 * Creates the World Monitor products and prices in Stripe, in whichever mode
 * the key belongs to.
 *
 * convex/lib/stripe.ts resolves a checkout price by lookup_key, never by id,
 * and points here by name when the lookup misses. So test and live can hold
 * different price ids for the same plan and the same code works in both — as
 * long as the lookup keys match. That is what this script guarantees.
 *
 * Idempotent. A price already carrying the right lookup key, amount, interval
 * and currency is left alone. Stripe prices are immutable, so a price whose
 * amount no longer matches the catalog is not edited: the script moves the
 * lookup key onto a new price and archives the old one, which is the only way
 * Stripe allows a price change.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=<key> node scripts/stripe-sync-catalog.mjs [--apply]
 *
 * Without --apply it prints the plan and changes nothing.
 */
import Stripe from 'stripe';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';

const APPLY = process.argv.includes('--apply');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set.');
  process.exit(1);
}

const stripe = new Stripe(key);

/**
 * One Stripe Product per plan family, holding that family's monthly and annual
 * prices. `planFamily` is what the products are found by on a re-run — names
 * are marketing copy and change, metadata does not.
 */
const FAMILIES = [
  { planFamily: 'pro', name: 'World Monitor Pro', plans: ['pro_monthly', 'pro_annual'] },
  { planFamily: 'api', name: 'World Monitor API', plans: ['api_starter', 'api_starter_annual'] },
  {
    planFamily: 'api_business',
    name: 'World Monitor API Business',
    plans: ['api_business', 'api_business_annual'],
  },
];

const INTERVAL_BY_PERIOD = { monthly: 'month', annual: 'year' };

async function findProduct(planFamily) {
  // No metadata search on the standard list endpoint, so read the page and
  // filter. The account holds tens of products, not thousands.
  for await (const product of stripe.products.list({ limit: 100, active: true })) {
    if (product.metadata?.app === 'worldmonitor' && product.metadata?.planFamily === planFamily) {
      return product;
    }
  }
  return null;
}

async function ensureProduct(family) {
  const existing = await findProduct(family.planFamily);
  if (existing) return { product: existing, created: false };
  if (!APPLY) return { product: { id: `(new) ${family.name}` }, created: true };

  const product = await stripe.products.create({
    name: family.name,
    metadata: { app: 'worldmonitor', planFamily: family.planFamily },
  });
  return { product, created: true };
}

async function ensurePrice(productId, entry) {
  const lookupKey = entry.providerPriceId;
  const interval = INTERVAL_BY_PERIOD[entry.billingPeriod];
  if (!interval) throw new Error(`${lookupKey}: unhandled billingPeriod ${entry.billingPeriod}`);

  const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const current = found.data[0];

  if (
    current &&
    current.unit_amount === entry.priceCents &&
    current.currency === 'usd' &&
    current.recurring?.interval === interval
  ) {
    return { lookupKey, action: 'unchanged', priceId: current.id };
  }

  if (!APPLY) {
    return { lookupKey, action: current ? 'replace' : 'create', priceId: current?.id ?? null };
  }

  // transfer_lookup_key moves the key off the old price in the same call, so
  // there is no window where the key resolves to nothing.
  const price = await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: entry.priceCents,
    recurring: { interval },
    lookup_key: lookupKey,
    transfer_lookup_key: Boolean(current),
  });

  if (current) await stripe.prices.update(current.id, { active: false });

  return { lookupKey, action: current ? 'replaced' : 'created', priceId: price.id };
}

const results = [];

for (const family of FAMILIES) {
  const { product, created } = await ensureProduct(family);
  results.push(`product ${family.name}: ${created ? 'create' : 'exists'} ${product.id}`);

  for (const planKey of family.plans) {
    const entry = PRODUCT_CATALOG[planKey];
    if (!entry) throw new Error(`PRODUCT_CATALOG has no entry named ${planKey}`);
    if (!entry.providerPriceId) throw new Error(`${planKey} has no providerPriceId`);

    if (!APPLY && product.id.startsWith('(new)')) {
      results.push(`  price ${entry.providerPriceId}: create ${entry.priceCents} usd`);
      continue;
    }

    const r = await ensurePrice(product.id, entry);
    results.push(`  price ${r.lookupKey}: ${r.action} ${entry.priceCents} usd ${r.priceId ?? ''}`);
  }
}

console.log(results.join('\n'));
console.log(APPLY ? '\napplied' : '\ndry run — pass --apply to write');
