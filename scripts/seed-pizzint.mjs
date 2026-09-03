#!/usr/bin/env node

// PizzINT — Google "popular times" for pizzerias near military/government
// sites, plus a GDELT tension overlay.
//
// Ported 2026-08-30 from seedPizzint in scripts/ais-relay.cjs (:6463-6570),
// which stopped writing when the Railway relay process died. The read side
// never moved: intelligence:pizzint:seed:v1 is still what the panel reads and
// the health row (pizzint) has been reporting the silence since.
//
// The baseline entry listed this among the seeds with "neither a data key nor
// a seed-meta key" and named an upstream change at pizzint.watch as the first
// thing to rule out. Measured 2026-08-30: the endpoint answers HTTP 200 with
// ~42KB, so the upstream is healthy and the relay's death is the whole story.
//
// Sources: pizzint.watch dashboard-data (no key), plus its GDELT batch
// endpoint for the tension pairs. The GDELT leg is best-effort by design — the
// relay treated it as non-fatal and so does this, because the DEFCON rollup is
// computed entirely from the pizzeria data and a GDELT outage should degrade
// the overlay rather than block the publish.
//
// The GDELT call is NOT a straight copy of the relay's. Measured 2026-08-30,
// the relay's URL (pairs + method only) answers HTTP 400:
//   {"error":"Missing required query parameters: pairs, method, dateStart, dateEnd"}
// Upstream added a mandatory date window at some point, so the relay's tension
// overlay was already dead before the container was. Because the leg is caught
// and non-fatal, that failure never surfaced — it just silently published
// tensionPairs: [] on every run. This sends an explicit window.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:pizzint:seed:v1';
const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
const GDELT_BATCH_API = 'https://www.pizzint.watch/api/gdelt/batch';
const DEFAULT_GDELT_PAIRS = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';

// 3h against the 30-minute cron below — 6x, the margin seed-market-quotes.mjs
// settled on. The relay ran a 10-minute loop with a 1800s (30-minute) TTL,
// which was 3x ITS interval; carrying that 1800 onto a 30-minute cron would be
// exactly 1x and would expire the key at the moment the next run came due.
const CACHE_TTL = 10800;

function mapLocation(d) {
  const num = (v) => (typeof v === 'number' ? v : 0);
  return {
    placeId: d.place_id || '',
    name: d.name || '',
    address: d.address || '',
    currentPopularity: num(d.current_popularity),
    percentageOfUsual: num(d.percentage_of_usual),
    isSpike: !!d.is_spike,
    spikeMagnitude: num(d.spike_magnitude),
    dataSource: d.data_source || '',
    recordedAt: d.recorded_at || '',
    dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    isClosedNow: !!d.is_closed_now,
    lat: d.lat ?? 0,
    lng: d.lng ?? 0,
  };
}

// Closed venues are excluded from the average deliberately: a shut pizzeria
// reports 0 popularity, and including those would drag the aggregate down in
// proportion to the time of day rather than to activity. Spikes still count
// even when closed, which is why activeSpikes reads the full list.
function buildPizzintRollup(locations) {
  const openLocations = locations.filter((l) => !l.isClosedNow);
  const activeSpikes = locations.filter((l) => l.isSpike).length;
  const avgPop = openLocations.length > 0
    ? openLocations.reduce((s, l) => s + l.currentPopularity, 0) / openLocations.length
    : 0;

  let adjusted = avgPop;
  if (activeSpikes > 0) adjusted += activeSpikes * 10;
  adjusted = Math.min(100, adjusted);

  let defconLevel = 5;
  let defconLabel = 'Normal Activity';
  if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
  else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
  else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
  else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

  return {
    defconLevel,
    defconLabel,
    aggregateActivity: Math.round(avgPop),
    activeSpikes,
    locationsMonitored: locations.length,
    locationsOpen: openLocations.length,
    updatedAt: Date.now(),
    dataFreshness: locations.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH')
      ? 'DATA_FRESHNESS_FRESH'
      : 'DATA_FRESHNESS_STALE',
    locations,
  };
}

// Only has to be long enough to contain two points, since the trend compares
// the last two. 90 days keeps a margin over upstream's own interpolation.
const GDELT_LOOKBACK_DAYS = 90;

function gdeltDateStamp(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');
}

async function fetchTensionPairs() {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - GDELT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const url = `${GDELT_BATCH_API}?pairs=${encodeURIComponent(DEFAULT_GDELT_PAIRS)}`
      + `&method=gpr&dateStart=${gdeltDateStamp(start)}&dateEnd=${gdeltDateStamp(now)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`  [GDELT] HTTP ${resp.status} — publishing without the tension overlay`);
      return [];
    }
    const raw = await resp.json();
    return Object.entries(raw).map(([pairKey, dataPoints]) => {
      const countries = pairKey.split('_');
      const points = Array.isArray(dataPoints) ? dataPoints : [];
      const latest = points[points.length - 1];
      const prev = points.length > 1 ? points[points.length - 2] : latest;
      const change = prev && prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
      return {
        id: pairKey,
        countries,
        label: countries.map((c) => c.toUpperCase()).join(' - '),
        score: latest?.v ?? 0,
        trend: change > 5 ? 'TREND_DIRECTION_RISING'
          : change < -5 ? 'TREND_DIRECTION_FALLING'
            : 'TREND_DIRECTION_STABLE',
        changePercent: Math.round(change * 10) / 10,
        region: 'global',
      };
    });
  } catch (err) {
    console.warn(`  [GDELT] ${err.message} — publishing without the tension overlay`);
    return [];
  }
}

async function fetchPizzint() {
  const resp = await fetch(PIZZINT_API, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`PizzINT HTTP ${resp.status}`);

  const raw = await resp.json();
  if (!raw.success || !Array.isArray(raw.data)) {
    throw new Error('PizzINT response carried no data array');
  }

  const locations = raw.data.map(mapLocation);
  const pizzint = buildPizzintRollup(locations);
  const tensionPairs = await fetchTensionPairs();

  console.log(
    `[PizzINT] ${locations.length} locations ` +
    `(open:${pizzint.locationsOpen} spikes:${pizzint.activeSpikes} ` +
    `defcon:${pizzint.defconLevel} gdelt:${tensionPairs.length})`,
  );

  return { pizzint, tensionPairs };
}

// A publish with no locations would compute DEFCON 5 "Normal Activity" from an
// empty set, which reads as a calm signal rather than as missing data. Refuse
// it and let last-good stand.
function validate(data) {
  return Array.isArray(data?.pizzint?.locations) && data.pizzint.locations.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.pizzint?.locations) ? data.pizzint.locations.length : 0;
}

if (process.argv[1]?.endsWith('seed-pizzint.mjs')) {
  runSeed('intelligence', 'pizzint', CANONICAL_KEY, fetchPizzint, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'pizzint',
    recordCount: (data) => data.pizzint.locations.length,
    declareRecords,
    schemaVersion: 1,
    // 60 = 2x the '5,35 * * * *' cron. api/health.js carried 30 ("relay loop
    // every 10min; 30 = 3x interval"), which would be 1x on this cadence.
    maxStaleMin: 60,
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
