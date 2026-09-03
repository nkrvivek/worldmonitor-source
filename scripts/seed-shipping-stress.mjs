#!/usr/bin/env node

// Shipping Stress Index — carrier/ETF market data as a supply-chain proxy.
//
// Ported 2026-08-09 from seedShippingStress in scripts/ais-relay.cjs
// (:5677-5744), which stopped writing when the Railway relay process died.
// The read side never moved: get-shipping-stress.ts still serves
// `supply_chain:shipping_stress:v1` and answers upstreamUnavailable when the
// key is gone, and the health row (shippingStress, maxStaleMin 45) has been
// reporting the silence since. This script is that writer, on the container
// rail like every other seed.
//
// Source: Yahoo chart API, no key. The relay routed through a Decodo proxy
// when Yahoo blocked its egress; the container starts direct-only, and a
// blocked run shows up as recordCount 0 in the seed log rather than being
// silently absorbed — add the proxy leg only if that actually happens.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'supply_chain:shipping_stress:v1';
// 1h against a 15-minute cron — 4x, same margin the relay ran.
const CACHE_TTL = 3600;

const SHIPPING_CARRIERS = [
  { symbol: 'BDRY', name: 'Breakwave Dry Bulk ETF', carrierType: 'etf' },
  { symbol: 'ZIM', name: 'ZIM Integrated Shipping', carrierType: 'carrier' },
  { symbol: 'MATX', name: 'Matson Inc', carrierType: 'carrier' },
  { symbol: 'SBLK', name: 'Star Bulk Carriers', carrierType: 'carrier' },
  { symbol: 'EGLE', name: 'Eagle Bulk Shipping', carrierType: 'carrier' },
];

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    console.warn(`  ${symbol}: HTTP ${resp.status}`);
    return null;
  }
  const data = await resp.json();
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  const closes = result.indicators?.quote?.[0]?.close;
  const sparkline = Array.isArray(closes) ? closes.filter((v) => v != null) : [];
  return { price, change, sparkline };
}

async function fetchShippingStress() {
  const carriers = [];
  for (const carrier of SHIPPING_CARRIERS) {
    // Small stagger, same as the relay: five bursts in one instant is the
    // request shape Yahoo rate-limits first.
    await new Promise((r) => setTimeout(r, 150));
    try {
      const quote = await fetchYahooChart(carrier.symbol);
      if (!quote) continue;
      carriers.push({
        symbol: carrier.symbol,
        name: carrier.name,
        carrierType: carrier.carrierType,
        price: quote.price,
        changePct: Number(quote.change.toFixed(2)),
        sparkline: quote.sparkline,
      });
    } catch (err) {
      console.warn(`  ${carrier.symbol}: ${err?.message || err}`);
    }
  }

  // Neutral market (0% change) → score 40 (moderate). Positive change =
  // lower stress. Same mapping the relay used; the reader renders the level
  // string as-is.
  const avgChange = carriers.length
    ? carriers.reduce((a, b) => a + b.changePct, 0) / carriers.length
    : 0;
  const stressScore = Math.min(100, Math.max(0, Math.round(40 - avgChange * 3)));
  const stressLevel =
    stressScore >= 75 ? 'critical' : stressScore >= 50 ? 'elevated' : stressScore >= 25 ? 'moderate' : 'low';

  return { carriers, stressScore, stressLevel, fetchedAt: Date.now() };
}

// All five missing = Yahoo rejected the run wholesale; keep last-good rather
// than publish a score computed from nothing.
function validate(data) {
  return Array.isArray(data?.carriers) && data.carriers.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.carriers) ? data.carriers.length : 0;
}

if (process.argv[1]?.endsWith('seed-shipping-stress.mjs')) {
  runSeed('supply_chain', 'shipping_stress', CANONICAL_KEY, fetchShippingStress, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'shipping-stress',
    recordCount: (data) => data.carriers.length,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 45,
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
