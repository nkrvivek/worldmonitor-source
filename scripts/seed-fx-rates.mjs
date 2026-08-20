#!/usr/bin/env node

/**
 * Dedicated FX rates seed — fetches all currencies used across bigmac + grocery-basket
 * and writes them to shared:fx-rates:v1 (25h TTL).
 *
 * Deploy as a Railway cron service (daily, e.g. "0 6 * * *") so downstream
 * weekly seeds always find a warm cache and make zero Yahoo FX calls themselves.
 * Saves ~90 Yahoo Finance calls per weekly seed cycle.
 *
 * Railway setup: rootDirectory=. startCommand="node scripts/seed-fx-rates.mjs"
 */

import { loadEnvFile, runSeed, fetchYahooFxRates, SHARED_FX_FALLBACKS } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'shared:fx-rates:v1';
// 63h, against the 60h staleness gate this key declares in api/health.js. The
// old 25h left no margin at all on a daily cron: one skipped or late run and
// the key was gone, so health read EMPTY — a fault status — for a seeder that
// was merely late, and the acceptance monitor went red every three hours until
// someone re-seeded by hand. The gate is the thing that decides how late is too
// late; the data has to survive long enough to be judged by it. Same shape as
// the seed-economy retirement in tests/seed-ttl-outlives-staleness-fleet.test.mjs.
// Consumers read through getSharedFxRates, which falls back to a live Yahoo
// fetch on a miss, so a longer TTL cannot starve them of a rate.
const CACHE_TTL = 63 * 3600;

// Union of all currencies used by bigmac + grocery-basket seeds
const ALL_CURRENCIES = [
  // Americas
  'USD', 'CAD', 'MXN', 'BRL', 'ARS', 'COP', 'CLP',
  // Europe
  'GBP', 'EUR', 'CHF', 'NOK', 'SEK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'UAH',
  // Asia-Pacific
  'CNY', 'JPY', 'KRW', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD', 'THB', 'MYR', 'IDR', 'PHP', 'VND', 'INR', 'PKR',
  // Middle East
  'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'EGP', 'JOD', 'LBP', 'ILS',
  // Africa
  'ZAR', 'NGN', 'KES',
  // Extra (grocery-basket only)
  'TRY',
];

const FX_SYMBOLS = Object.fromEntries(
  ALL_CURRENCIES.map(c => [c, `${c}USD=X`])
);

const FX_FALLBACKS = SHARED_FX_FALLBACKS;

export function declareRecords(data) {
  return data && typeof data === 'object' ? Object.keys(data).length : 0;
}

await runSeed('shared', 'fx-rates', CANONICAL_KEY, async () => {
  // Always fetch live — this seed IS the cache writer, bypass getSharedFxRates
  const rates = await fetchYahooFxRates(FX_SYMBOLS, FX_FALLBACKS);
  console.log('  Fetched', Object.keys(rates).length, 'currencies');
  return rates;
}, {
  ttlSeconds: CACHE_TTL,
  validateFn: (data) => data && typeof data === 'object' && Object.keys(data).length > 10,
  recordCount: (data) => Object.keys(data).length,
  sourceVersion: 'yahoo-fx-shared',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 3600,
});
