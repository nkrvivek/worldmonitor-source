#!/usr/bin/env node
// Seed labor market time series via FRED (replaces direct BLS API which is blocked
// from Railway container IPs — api.bls.gov rejects HTTPS CONNECT through proxies).
// FRED mirrors the national BLS series with identical data and no IP restrictions.
// Metro-area unemployment rates (LAUMT*) are dropped; no FRED equivalent exists.

import { loadEnvFile, runSeed, writeExtraKeyWithMeta, sleep, resolveProxyForConnect, fredFetchJson } from './_seed-utils.mjs';
import { tokensToContentMeta, DAY_MIN } from './_content-age-helpers.mjs';

loadEnvFile(import.meta.url);

const _proxyAuth = resolveProxyForConnect();

const CANONICAL_KEY = 'bls:series:v1';
const KEY_PREFIX = 'bls:series';
const CACHE_TTL = 259200; // 72h = 3× daily seed interval
// Content-age budget — the newest observation across the FRED-mirrored BLS
// series. The dominant freeze mode is FRED-stops or BLS-discontinues; 75 days
// clears the monthly publication lag plus a missed cycle while flipping
// /api/health to STALE_CONTENT well before a real BLS outage is invisible.
// See #3845.
//
// newestItemAt is the MAX across series, so this budget can only see a
// whole-upstream freeze. One series freezing or dropping out is masked by the
// others, and that is not hypothetical: on 2026-08-12 the USPRIV fetch failed,
// the seed published ECIALLCIV alone, and the payload halved without failing
// anything. Per-series liveness is checked in fetchAllSeries instead, against
// each series' own publication cadence, so a gap is a failed run rather than a
// quieter success.
const BLS_MAX_CONTENT_AGE_MIN = 75 * DAY_MIN;

// FRED equivalents for the national BLS series.
// seriesId must match what the RPC handler and frontend BLS_SERIES array use.
//
// maxObservationAgeDays is sized per series against its own release schedule,
// measured from the observation's own period START (the convention
// periodTokenToMs uses), never from the release date:
//   USPRIV     monthly, released ~3 weeks after the month starts. 75 days
//              clears one publication lag plus a missed cycle.
//   ECIALLCIV  quarterly, released ~4 months after the quarter starts (Q2 is
//              stamped 2026-04-01 and landed 2026-07-31), so the newest
//              observation is ~213 days old the day before Q3 posts. 240 days
//              clears that gap with room for release-date drift and nothing
//              more — a skipped quarter still trips it.
const FRED_SERIES = [
  { id: 'USPRIV',    title: 'Total Private Nonfarm Payrolls', units: 'Thousands of Persons', fredId: 'USPRIV', maxObservationAgeDays: 75 },
  { id: 'ECIALLCIV', title: 'Employment Cost Index - All Civilian Workers', units: 'Index (Dec 2005=100)', fredId: 'ECIALLCIV', maxObservationAgeDays: 240 },
];

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/** Convert a FRED date string ("2024-12-01") to BLS-style observation fields. */
function fredDateToBls(dateStr) {
  const [year, mm] = dateStr.split('-');
  const monthIdx = parseInt(mm, 10) - 1;
  const period = `M${mm.padStart(2, '0')}`;
  const periodName = MONTH_NAMES[monthIdx] ?? mm;
  return { year, period, periodName };
}

async function fetchFredSeries(fredId) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');

  const currentYear = new Date().getFullYear();
  const startDate = `${currentYear - 5}-01-01`;

  const params = new URLSearchParams({
    series_id: fredId,
    api_key: apiKey,
    file_type: 'json',
    sort_order: 'asc',
    observation_start: startDate,
  });

  const data = await fredFetchJson(`https://api.stlouisfed.org/fred/series/observations?${params}`, _proxyAuth);
  const raw = data?.observations ?? [];

  const observations = raw
    .filter(o => o.value && o.value !== '.' && o.date)
    .map(o => ({
      ...fredDateToBls(o.date),
      value: o.value,
    }));

  return { observations };
}

/** Epoch ms of the newest observation in one series, or null when it has none. */
export function newestObservationMs(series, nowMs = Date.now()) {
  const tokens = [];
  for (const o of Array.isArray(series?.observations) ? series.observations : []) {
    const mm = /^M(\d{2})$/.exec(o?.period ?? '');
    if (mm && o?.year) tokens.push(`${o.year}-${mm[1]}`);
  }
  return tokensToContentMeta(tokens, nowMs)?.newestItemAt ?? null;
}

/**
 * Name every declared series the payload cannot vouch for.
 *
 * Two faults, both of which used to publish as an ordinary success:
 *   absent  — the fetch failed and the seed shipped whatever survived. The
 *             aggregate content-age budget cannot see this, because
 *             newestItemAt is the max across whatever is left.
 *   frozen  — FRED still serves the series but has stopped adding to it, so
 *             the shape is right and only the observation dates say otherwise.
 *
 * @returns {Array<{id: string, reason: string}>} empty when the payload is whole.
 */
export function describeSeriesFaults(data, nowMs = Date.now(), defs = FRED_SERIES) {
  const byId = new Map(
    (Array.isArray(data?.series) ? data.series : []).map((s) => [s?.seriesId, s]),
  );
  const faults = [];
  for (const def of defs) {
    const series = byId.get(def.id);
    if (!series) {
      faults.push({ id: def.id, reason: 'absent from the payload' });
      continue;
    }
    const newest = newestObservationMs(series, nowMs);
    if (newest == null) {
      faults.push({ id: def.id, reason: 'no dated observation' });
      continue;
    }
    const ageDays = Math.round((nowMs - newest) / (DAY_MIN * 60_000));
    if (ageDays > def.maxObservationAgeDays) {
      faults.push({
        id: def.id,
        reason: `newest observation is ${ageDays}d old, budget ${def.maxObservationAgeDays}d`,
      });
    }
  }
  return faults;
}

async function fetchAllSeries() {
  const all = [];
  const perKeySeries = {};

  for (let i = 0; i < FRED_SERIES.length; i++) {
    const def = FRED_SERIES[i];
    if (i > 0) await sleep(200);
    console.log(`  Fetching ${def.id} (${def.title}) via FRED...`);

    let result = null;
    try {
      result = await fetchFredSeries(def.fredId);
      console.log(`    ${result?.observations?.length ?? 0} observations`);
    } catch (err) {
      console.warn(`    ${def.id}: failed (${err.message})`);
    }

    if (result) {
      const series = {
        seriesId: def.id,
        title: def.title,
        units: def.units,
        observations: result.observations,
      };
      all.push(series);
      perKeySeries[`${KEY_PREFIX}:${def.id}`] = { series };
    }
  }

  const payload = { series: all, perKeySeries, fetchedAt: new Date().toISOString() };

  // A half payload is a failed run, not a smaller one. Throwing here rather
  // than returning puts the run on runSeed's fetch-failure path: withRetry
  // fetches again, so a transient FRED refusal heals inside the run, and if it
  // does not, the last whole payload keeps its TTL and seed-meta is left
  // un-refreshed so /api/health ages into STALE instead of reporting a fresh
  // seed over half the data.
  const faults = describeSeriesFaults(payload);
  if (faults.length) {
    throw new Error(
      `${faults.length} of ${FRED_SERIES.length} series unusable: `
      + faults.map((f) => `${f.id} (${f.reason})`).join('; '),
    );
  }

  return payload;
}

function validate(data) {
  return Array.isArray(data?.series)
    && data.series.length > 0
    && describeSeriesFaults(data).length === 0;
}

function publishTransform(data) {
  const { perKeySeries: _pks, ...rest } = data;
  return rest;
}

async function afterPublish(data, _meta) {
  for (const [key, value] of Object.entries(data.perKeySeries ?? {})) {
    const seriesId = key.replace(`${KEY_PREFIX}:`, '');
    await writeExtraKeyWithMeta(key, value, CACHE_TTL, value.series?.observations?.length ?? 0, `bls:series:${seriesId}`);
  }
}

export function declareRecords(data) {
  return Array.isArray(data?.series) ? data.series.length : 0;
}

// Content-age contract: newest observation across all series, derived from the
// BLS year + period (M01..M12) pair. Detects a frozen FRED/BLS feed that
// seeder-liveness checks cannot — see scripts/_content-age-helpers.mjs.
export function blsContentMeta(data) {
  const tokens = [];
  for (const s of Array.isArray(data?.series) ? data.series : []) {
    for (const o of Array.isArray(s?.observations) ? s.observations : []) {
      const mm = /^M(\d{2})$/.exec(o?.period ?? '');
      if (mm && o?.year) tokens.push(`${o.year}-${mm[1]}`);
    }
  }
  return tokensToContentMeta(tokens);
}

if (process.argv[1]?.endsWith('seed-bls-series.mjs')) {
  runSeed('economic', 'bls-series', CANONICAL_KEY, fetchAllSeries, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    // afterPublish writes these outside runSeed's extra-key phase, so a failed
    // run has to be told to hold them at their last-good TTL. Without this a
    // series that survives the failure expires anyway, three runs later.
    preserveKeys: FRED_SERIES.map((def) => `${KEY_PREFIX}:${def.id}`),
    sourceVersion: 'fred-v1',
    publishTransform,
    afterPublish,

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 2880,
    contentMeta: blsContentMeta,
    maxContentAgeMin: BLS_MAX_CONTENT_AGE_MIN,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(0);
  });
}
