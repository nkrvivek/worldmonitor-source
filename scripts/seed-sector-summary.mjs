#!/usr/bin/env node

// Sector Summary — the 11 SPDR sector ETFs plus SMH, with Yahoo valuations.
//
// Ported 2026-08-30 from seedSectorSummary in scripts/ais-relay.cjs
// (:2367-2440), which stopped writing when the Railway relay process died.
// The read side never moved: market:sectors:v2 is still what the sector panel
// reads, and the health row (sectors) has been reporting EMPTY since.
//
// Why this one looked like a code bug and was not. The baseline entry for
// `sectors` records that every sibling written by the relay's own
// seedAllMarketDataOnce() pass stayed fresh (commodities, gulf-quotes,
// etf-flows, crypto, stablecoins, crypto-sectors, token-panels, stocks) while
// this key alone went missing, which pointed at seedSectorSummary()'s
// `sectors.length === 0` early return. It also verified FINNHUB_API_KEY
// answers 200 for these exact ETFs (XLK 183.64, XLF 57.48, SMH 560.92). The
// remaining explanation was the relay container's own environment:
// docker-compose passed FINNHUB_API_KEY as "${FINNHUB_API_KEY:-}", which is
// empty when the deploy env does not set it, and the Yahoo fallback had to be
// blocked at the same time. That is not reproducible from the repo and the
// container is gone, so this port sidesteps the question entirely: it runs on
// the container rail with the same key every other market seed already uses.
//
// Sources: Finnhub /quote for the change percentages (primary), Yahoo chart as
// the fallback leg, and Yahoo quoteSummary/v7 for the valuation overlay via
// the shared _yahoo-sector-valuations.cjs client. The valuation collector is
// best-effort by construction: it carries its own last-good cache and returns
// coverage diagnostics, so a Yahoo auth failure degrades the overlay without
// failing the publish.

import { createRequire } from 'node:module';
import {
  loadEnvFile,
  sleep,
  CHROME_UA,
  runSeed,
  parseYahooChart,
  writeExtraKey,
  getRedisCredentials,
} from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';

const require = createRequire(import.meta.url);
// _seed-utils.mjs keeps resolveProxyString module-local, so take it from the
// same .cjs the relay used rather than widening that module's surface.
const { resolveProxyString } = require('./_proxy-utils.cjs');
const {
  YahooQuoteSummaryClient,
  buildSectorValuationCoverage,
  buildSectorValuationPublication,
  buildSectorSeedMeta,
  collectSectorValuations,
} = require('./_yahoo-sector-valuations.cjs');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:sectors:v2';
// 3h against the 30-minute cron below — 6x, matching the margin
// seed-market-quotes.mjs settled on after the 1800 = exactly-one-interval bug
// described in tests/seed-ttl-outlives-staleness-fleet.test.mjs. The relay's
// MARKET_SEED_TTL was sized for a */5 cadence that no longer applies.
const CACHE_TTL = 10800;
const YAHOO_DELAY_MS = 150;

const SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];
const QUOTES_KEY = `market:quotes:v1:${[...SECTOR_SYMBOLS].sort().join(',')}`;

// The valuation collector's last-good cache speaks raw Upstash REST, same wire
// protocol as scripts/seed-aviation.mjs. Both read paths swallow their own
// errors: a cold or unreachable cache must not fail the sector publish.
async function upstashCommand(cmd) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Upstash ${cmd[0]} failed: HTTP ${resp.status}`);
  return resp.json();
}

async function upstashGet(key) {
  try {
    const result = await upstashCommand(['GET', key]);
    if (!result?.result) return null;
    try { return JSON.parse(result.result); } catch { return null; }
  } catch { return null; }
}

async function upstashSet(key, value, ttlSeconds) {
  try {
    const cmd = ['SET', key, JSON.stringify(value)];
    if (ttlSeconds) cmd.push('EX', String(ttlSeconds));
    const result = await upstashCommand(cmd);
    return result?.result === 'OK';
  } catch { return false; }
}

const _yahooQuoteSummaryClient = new YahooQuoteSummaryClient({
  userAgent: CHROME_UA,
  resolveProxyString,
  cooldownMs: 5 * 60 * 1000,
  logger: {
    warn(message, { transport } = {}) {
      console.warn(`  [Yahoo:${transport || 'direct'}] ${message}`);
    },
  },
});

function parseSectorValuation(raw) {
  if (!raw) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const toNum = (v) => num(typeof v === 'string' ? parseFloat(v) : v);
  const trailingPE = toNum(raw.trailingPE);
  const forwardPE = toNum(raw.forwardPE);
  // P/E is the point of the overlay; a row with neither is noise, not coverage.
  if (trailingPE === null && forwardPE === null) return null;
  return {
    trailingPE,
    forwardPE,
    beta: toNum(raw.beta),
    ytdReturn: toNum(raw.ytdReturn),
    threeYearReturn: toNum(raw.threeYearReturn),
    fiveYearReturn: toNum(raw.fiveYearReturn),
  };
}

async function fetchFinnhubChange(symbol, apiKey) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // Finnhub answers 200 with an all-zero body for symbols it does not cover.
    if (data.c === 0 && data.h === 0 && data.l === 0) return null;
    return { symbol, name: symbol, change: data.dp };
  } catch (err) {
    console.warn(`  [Finnhub] ${symbol}: ${err.message}`);
    return null;
  }
}

async function fetchYahooChange(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const parsed = parseYahooChart(await fetchYahooJson(url, { label: symbol }), symbol);
    return parsed ? { symbol, name: symbol, change: parsed.change } : null;
  } catch (err) {
    console.warn(`  [Yahoo] ${symbol}: ${err.message}`);
    return null;
  }
}

async function fetchSectorSummary() {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  let sectors = [];

  if (finnhubKey) {
    const results = await Promise.all(SECTOR_SYMBOLS.map((s) => fetchFinnhubChange(s, finnhubKey)));
    sectors = results.filter(Boolean);
  } else {
    console.warn('[Market] FINNHUB_API_KEY unset — going straight to the Yahoo leg');
  }

  // The relay fell back only on a total Finnhub wipeout, which is what made the
  // double failure invisible. Fall back on any shortfall instead, so a partial
  // Finnhub answer still publishes a complete sector set.
  if (sectors.length < SECTOR_SYMBOLS.length) {
    const have = new Set(sectors.map((s) => s.symbol));
    for (const symbol of SECTOR_SYMBOLS) {
      if (have.has(symbol)) continue;
      const yahoo = await fetchYahooChange(symbol);
      if (yahoo) sectors.push(yahoo);
      await sleep(YAHOO_DELAY_MS);
    }
  }

  if (sectors.length === 0) {
    // Both legs blocked. Returning empty lets validate() below hold last-good
    // rather than stamping seed-meta fresh over a publish of nothing — the
    // exact failure that made this key look alive on the relay right up until
    // it expired.
    console.warn('[Market] No sector data from Finnhub or Yahoo — holding last-good');
    return { sectors: [], valuationCoverage: null, payload: null };
  }

  // Keep the configured display order rather than completion order, so the
  // panel does not reshuffle when the fallback leg fills a different subset.
  sectors.sort((a, b) => SECTOR_SYMBOLS.indexOf(a.symbol) - SECTOR_SYMBOLS.indexOf(b.symbol));

  const {
    valuations,
    valuationSources,
    valuationCount,
    unavailableSymbols,
    valuationDiagnostics,
    lastGoodFetchedAt,
    lastGoodMetricsUsed,
  } = await collectSectorValuations({
    symbols: SECTOR_SYMBOLS,
    fetchValue: (symbol) => _yahooQuoteSummaryClient.fetch(symbol),
    fetchValueDetailed: (symbol, options) => _yahooQuoteSummaryClient.fetchDetailed(symbol, options),
    parseValue: parseSectorValuation,
    sleepFn: sleep,
    v7UserAgent: CHROME_UA,
    v7ResolveProxyString: resolveProxyString,
    v7Client: _yahooQuoteSummaryClient,
    upstashGet,
    upstashSet,
  });

  const valuationCoverage = buildSectorValuationCoverage({
    valuationCount,
    expectedCount: SECTOR_SYMBOLS.length,
    fetchedAt: Date.now(),
    sources: valuationSources,
    unavailableSymbols,
    valuationDiagnostics,
    lastGoodFetchedAt,
    lastGoodMetricsUsed,
  });

  const { payload, meta } = buildSectorValuationPublication({
    sectors,
    valuations,
    valuationCoverage,
  });

  console.log(
    `[Market] ${sectors.length}/${SECTOR_SYMBOLS.length} sectors, ` +
    `${valuationCount}/${SECTOR_SYMBOLS.length} valuations (${valuationCoverage.sourceStatus})`,
  );

  return { sectors, valuationCoverage, payload, meta };
}

// Two jobs, both required.
//
// 1. The panel routes sector reads through market:quotes:v1 as well as the
//    canonical key, same as seed-commodity-quotes.mjs. price is 0 because the
//    relay never carried a price on this path and the reader only renders the
//    change percentage.
//
// 2. Return the sector-specific diagnostics as a freshnessMetaPatch. This is
//    not optional decoration: api/health.js classifies this row on
//    sectorRecordCount, valuationRecordCount, expectedValuationRecordCount and
//    sourceState, and tests/health-classify.test.mjs pins that behaviour
//    (a valuation wipeout must read SEED_ERROR/warn while price coverage stays
//    visible, and recovery must return to OK). Writing only the standard
//    freshness fields would leave the classifier unable to tell a healthy
//    publish from a degraded one. runSeed owns fetchedAt/recordCount/
//    sourceVersion — FRESHNESS_META_RESERVED_FIELDS drops them from any patch —
//    so buildSectorSeedMeta's overlapping keys are discarded by design and only
//    the sector diagnostics survive.
async function writeQuotesCompanion(result) {
  if (!result?.sectors?.length) return undefined;
  const quotesPayload = {
    quotes: result.sectors.map((s) => ({
      symbol: s.symbol, name: s.name, display: s.name,
      price: 0, change: s.change, sparkline: [],
    })),
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
  };
  await writeExtraKey(QUOTES_KEY, quotesPayload, CACHE_TTL);
  // canonicalPayloadWritten=true: afterPublish only runs once the canonical
  // write succeeded, which is exactly the condition the second argument means.
  return { freshnessMetaPatch: buildSectorSeedMeta(result.meta, true) };
}

// A publish with no sectors is the one state worth refusing: the overlay is
// allowed to be empty, the sector list is not.
function validate(data) {
  return Array.isArray(data?.sectors) && data.sectors.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.sectors) ? data.sectors.length : 0;
}

if (process.argv[1]?.endsWith('seed-sector-summary.mjs')) {
  runSeed('market', 'sectors', CANONICAL_KEY, fetchSectorSummary, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'market-sectors',
    recordCount: (data) => data.sectors.length,
    declareRecords,
    schemaVersion: 2,
    // 2x the 30-minute cron, the same margin api/health.js allows the sibling
    // market rows.
    // 2x the '11,41' cron below. api/health.js and api/mcp/constants.ts carry
    // maxStaleMin 30 for this row, which was 2x the relay's 15-minute cadence;
    // on the 30-minute container rail that same 30 would be exactly 1x, so a
    // single late tick reads STALE on a seeder that just succeeded. Both
    // registrations move to 60 with this port. CACHE_TTL 10800 stays well above
    // maxStaleMin*60 = 3600, satisfying the fleet guard in
    // tests/seed-ttl-outlives-staleness-fleet.test.mjs.
    maxStaleMin: 60,
    // Publish the built sector/valuation payload, not the internal shape.
    publishTransform: (data) => data.payload,
    preserveKeys: [QUOTES_KEY],
    afterPublish: writeQuotesCompanion,
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
