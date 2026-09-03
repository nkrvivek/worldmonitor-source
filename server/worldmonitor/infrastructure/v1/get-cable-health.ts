import type {
  ServerContext,
  GetCableHealthRequest,
  GetCableHealthResponse,
  CableHealthRecord,
  CableHealthEvidence,
  CableHealthStatus,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { cachedFetchJson, setCachedJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { NGA_BROADCAST_WARN_URL, parseNgaBroadcastWarnings } from '../../../_shared/nga';

// ========================================================================
// Constants
// ========================================================================

const CACHE_KEY = 'cable-health-v1';
/**
 * How long a computed map is served, and therefore how long `cable-health-v1`
 * exists at all.
 *
 * This has to outlive api/health.js's `SEED_META.cableHealth.maxStaleMin`, and
 * that ordering is the whole point of the constant. seed-meta is written with a
 * 7-day TTL and dated from `generatedAt`, so health.js goes on vouching for a
 * reading for 90 minutes. When this key expired first, the two contradicted
 * each other: meta said a reading exists and is fresh, the data key was gone,
 * and `MISSING_DATA_IS_FAILURE_KEYS` turned that pair into `EMPTY` — a data key
 * expiring inside its own freshness bound is a false EMPTY by construction.
 *
 * Measured 2026-08-14: `cableHealth: status=EMPTY records=0 age=35m max=90m`
 * failed the Seed Freshness Monitor while NGA was fine and the endpoint was
 * healthy. One authenticated warm returned 200 with a computed map and health
 * flipped to OK within seconds. The value was 1800 against a bound of 90
 * minutes, so every warm gap between 30 and 90 minutes produced this, and the
 * GitHub warm cron was running at 07:46, 06:02, 04:30, 02:38, 00:02 against a
 * 15-minute schedule.
 *
 * Recompute cadence is what is being traded away, and it costs nothing here:
 * `recencyWeight` decays over 12 hours to 5 days, so a map recomputed every two
 * hours rather than every thirty minutes is the same map.
 *
 * It also closes the same hole on the NGA-failure path below, which writes the
 * fallback back under this key for 120s. That path is now unreachable until
 * this TTL has expired, by which point seed-meta has aged past 90 minutes and
 * health.js reports the honest `STALE_SEED` instead of `EMPTY`.
 *
 * tests/cable-health-cache-outlives-freshness-bound.test.mts fails if the two
 * halves drift back into disagreeing.
 */
export const CACHE_TTL = 7200; // 2h — must exceed SEED_META.cableHealth.maxStaleMin (90 min)

/**
 * How old a served map may get before the next request recomputes it.
 *
 * CACHE_TTL was doing two jobs: how long a map is served, and how often one is
 * built. They cannot both be right. A key that only expires at two hours is
 * only recomputed every two hours, so `generatedAt` moved every 120 minutes
 * against a 90-minute bound and cableHealth spent the last half-hour of every
 * cycle in STALE_SEED. Measured 2026-08-19: `status=STALE_SEED records=0
 * age=122m max=90m` on a healthy endpoint, warmed on time throughout.
 *
 * The 2026-08-14 note above traded recompute cadence away to kill a false
 * EMPTY. That trade is what produced this. Splitting the constant keeps both:
 * the key still outlives the bound, and the map is rebuilt inside it.
 *
 * 45 minutes against a 15-minute warm (scripts/seed-warm-ping.mjs, Cloudflare
 * cron) puts the worst served age at about an hour. Recompute is cheap: the
 * NGA warnings it reads are cached for 24h under NGA_CACHE_KEY, so this reruns
 * processNgaSignals over Redis and touches no upstream.
 *
 * tests/cable-health-cache-outlives-freshness-bound.test.mts pins it below the
 * bound, as it pins CACHE_TTL above it.
 */
export const REFRESH_AFTER_MS = 45 * 60_000; // 45m — must stay under SEED_META.cableHealth.maxStaleMin (90 min)
const NGA_CACHE_KEY = 'cable-health-nga-warnings-v1';
const NGA_CACHE_TTL = 86400; // 24h — raw NGA warnings are stable; long TTL survives relay downtime without hammering upstream

// In-memory fallback: serves stale data when both Redis and NGA are down
let fallbackCache: GetCableHealthResponse | null = null;

// ========================================================================
// NGA warning types
// ========================================================================

interface NgaWarning {
  text?: string;
  issueDate?: string;
  navArea?: string;
  msgYear?: number;
  msgNumber?: number;
}

// ========================================================================
// Cable keywords and patterns
// ========================================================================

const CABLE_KEYWORDS = [
  'CABLE', 'CABLESHIP', 'CABLE SHIP', 'CABLE LAYING',
  'CABLE OPERATIONS', 'SUBMARINE CABLE', 'UNDERSEA CABLE',
  'FIBER OPTIC', 'TELECOMMUNICATIONS CABLE',
];

const FAULT_KEYWORDS = /FAULT|BREAK|CUT|DAMAGE|SEVERED|RUPTURE|OUTAGE|FAILURE/i;
const SHIP_PATTERNS = [
  /CABLESHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CABLE\s+SHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CS\s+([A-Z][A-Z0-9\s\-']+)/i,
  /M\/V\s+([A-Z][A-Z0-9\s\-']+)/i,
];
const ON_STATION_RE = /ON STATION|OPERATIONS IN PROGRESS|LAYING|REPAIRING|WORKING|COMMENCED/i;

// Known cable names -> cableId mapping
// IDs are TeleGeography slugs with hyphens→underscores (generated by scripts/seed-submarine-cables.mjs).
// Must be updated manually when cables are added/renamed in the seed script.
const CABLE_NAME_MAP: Record<string, string> = {
  'MAREA': 'marea',
  'GRACE HOPPER': 'grace_hopper',
  'HAVFRUE': 'havfrueaec_2',
  'AEC-2': 'havfrueaec_2',
  'FASTER': 'faster',
  'SOUTHERN CROSS': 'southern_cross_cable_network_sccn',
  'CURIE': 'curie',
  'SEA-ME-WE 6': 'seamewe_6',
  'SEA-ME-WE 5': 'seamewe_5',
  'SEA-ME-WE 4': 'seamewe_4',
  'SEA-ME-WE': 'seamewe_6',
  'SEAMEWE': 'seamewe_6',
  'SMW6': 'seamewe_6',
  'SMW5': 'seamewe_5',
  'SMW4': 'seamewe_4',
  '2AFRICA': '2africa',
  'WACS': 'west_africa_cable_system_wacs',
  'EASSY': 'eastern_africa_submarine_system_eassy',
  'SAM-1': 'south_america_1_sam_1',
  'SAM1': 'south_america_1_sam_1',
  'ELLALINK': 'ellalink',
  'ELLA LINK': 'ellalink',
  'APG': 'asia_pacific_gateway_apg',
  'INDIGO': 'indigo_west',
  'SJC': 'southeast_asia_japan_cable_sjc',
  'SJC2': 'southeast_asia_japan_cable_2_sjc2',
  'FARICE': 'farice_1',
  'FALCON': 'falcon',
  'DUNANT': 'dunant',
  'AMITIE': 'amitie',
  'APOLLO': 'apollo',
  'AC-1': 'atlantic_crossing_1_ac_1',
  'TPE': 'trans_pacific_express_tpe_cable_system',
  'NCP': 'new_cross_pacific_ncp_cable_system',
  'JUPITER': 'jupiter',
  'EQUIANO': 'equiano',
  'ACE CABLE': 'africa_coast_to_europe_ace',
  'AFRICA COAST TO EUROPE': 'africa_coast_to_europe_ace',
  'MAINONE': 'mainone',
  'SAFE CABLE': 'safe',
  'SAT-3': 'safe',
  'TEAMS CABLE': 'the_east_african_marine_system_teams',
  'EAST AFRICAN MARINE': 'the_east_african_marine_system_teams',
  'PEACE CABLE': 'peace_cable',
  'IMEWE': 'imewe',
  'AAE-1': 'asia_africa_europe_1_aae_1',
  'AAG': 'asia_america_gateway_aag_cable_system',
  'BRUSA': 'brusa',
  'MONET': 'monet',
  'FIRMINA': 'firmina',
  'ARCOS': 'arcos',
  'GLOBENET': 'globenet',
  'BIFROST': 'bifrost',
  'APRICOT': 'apricot',
  'RAMAN': 'raman',
  'FLAG': 'flag_atlantic_1_fa_1',
  'FLAG ATLANTIC': 'flag_atlantic_1_fa_1',
};

// Minimal cable geometry for proximity matching (landing coords: [lat, lon])
// IDs must match seed-submarine-cables.mjs slug-based output
const CABLE_LANDINGS: Record<string, [number, number][]> = {
  marea: [[36.85, -75.98], [43.26, -2.93]],
  grace_hopper: [[40.57, -73.97], [50.83, -4.55], [43.26, -2.93]],
  havfrueaec_2: [[40.22, -74.01], [58.15, 8.0], [55.56, 8.13]],
  dunant: [[46.69, -1.97], [36.76, -76.06]],
  amitie: [[44.89, -1.21], [50.83, -4.54], [42.46, -70.95]],
  faster: [[43.37, -124.22], [34.95, 139.95], [34.32, 136.85]],
  southern_cross_cable_network_sccn: [[-33.87, 151.21], [-36.85, 174.76], [33.74, -118.27]],
  curie: [[33.74, -118.27], [-33.05, -71.62]],
  seamewe_6: [[1.35, 103.82], [19.08, 72.88], [25.13, 56.34], [21.49, 39.19], [29.97, 32.55], [43.30, 5.37]],
  seamewe_5: [[1.35, 103.82], [19.08, 72.88], [43.30, 5.37]],
  seamewe_4: [[1.35, 103.82], [19.08, 72.88], [43.30, 5.37]],
  '2africa': [[50.83, -4.55], [38.72, -9.14], [14.69, -17.44], [6.52, 3.38], [-33.93, 18.42], [-4.04, 39.67], [21.49, 39.19], [31.26, 32.30]],
  west_africa_cable_system_wacs: [[-33.93, 18.42], [6.52, 3.38], [14.69, -17.44], [38.72, -9.14], [51.51, -0.13]],
  eastern_africa_submarine_system_eassy: [[-29.85, 31.02], [-25.97, 32.58], [-6.80, 39.28], [-4.04, 39.67], [11.59, 43.15]],
  south_america_1_sam_1: [[-22.91, -43.17], [-34.60, -58.38], [26.36, -80.08]],
  ellalink: [[38.72, -9.14], [-3.72, -38.52]],
  asia_pacific_gateway_apg: [[35.69, 139.69], [25.15, 121.44], [22.29, 114.17], [1.35, 103.82]],
  indigo_west: [[-31.95, 115.86], [1.35, 103.82], [-6.21, 106.85]],
  southeast_asia_japan_cable_sjc: [[35.69, 139.69], [36.07, 120.32], [1.35, 103.82], [22.29, 114.17]],
  farice_1: [[64.13, -21.90], [62.01, -6.77], [55.95, -3.19]],
  falcon: [[25.13, 56.34], [23.59, 58.38], [26.23, 50.59], [29.38, 47.98]],
  equiano: [[38.72, -9.14], [6.52, 3.38], [-33.93, 18.42]],
  peace_cable: [[25.13, 56.34], [-4.04, 39.67], [43.30, 5.37]],
  imewe: [[43.30, 5.37], [19.08, 72.88], [25.13, 56.34]],
  brusa: [[36.85, -75.98], [-22.91, -43.17]],
  firmina: [[36.85, -75.98], [-3.72, -38.52], [-34.60, -58.38]],
  jupiter: [[33.74, -118.27], [34.95, 139.95], [14.55, 121.0]],
  flag_atlantic_1_fa_1: [[50.04, -5.66], [40.57, -73.97], [43.30, 5.37]],
};

// ========================================================================
// Signal types
// ========================================================================

interface Signal {
  cableId: string;
  ts: number; // epoch ms
  severity: number;
  confidence: number;
  ttlSeconds: number;
  kind: string;
  evidence: Array<{ source: string; summary: string; ts: number }>;
}

// ========================================================================
// NGA fetch
// ========================================================================

async function fetchNgaWarnings(): Promise<NgaWarning[] | null> {
  try {
    const res = await fetch(
      NGA_BROADCAST_WARN_URL,
      { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    );
    if (!res.ok) return null; // fetch failed — don't cache, let sentinel TTL govern retry
    const rows = parseNgaBroadcastWarnings(await res.json());
    if (rows === null) {
      // A shape we do not recognize is an upstream failure, not a quiet sea.
      // This line used to read `data.warnings`, which NGA has never sent, and
      // `?? []` cached the resulting empty array for 24h — one wrong key name
      // cost a full day of empty cable maps, and nothing threw.
      console.warn('[cable-health] NGA returned an unrecognized payload shape');
      return null;
    }
    return rows as NgaWarning[];
  } catch {
    return null; // network error — don't poison NGA cache with empty data
  }
}

// ========================================================================
// Text analysis helpers
// ========================================================================

export function isCableRelated(text: string): boolean {
  const upper = text.toUpperCase();
  return CABLE_KEYWORDS.some((kw) => upper.includes(kw));
}

export function parseCoordinates(text: string): [number, number][] {
  const coords: [number, number][] = [];
  const dms = /(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/gi;
  let m: RegExpExecArray | null;
  while ((m = dms.exec(text)) !== null) {
    let lat = parseInt(m[1]!, 10) + parseFloat(m[2]!) / 60;
    let lon = parseInt(m[4]!, 10) + parseFloat(m[5]!) / 60;
    if (m[3]!.toUpperCase() === 'S') lat = -lat;
    if (m[6]!.toUpperCase() === 'W') lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) coords.push([lat, lon]);
  }
  return coords;
}

const _cableNamePatterns = new Map(
  Object.entries(CABLE_NAME_MAP).map(([name, id]) => [
    new RegExp(`\\b${name.replace(/[-/]/g, '\\$&')}\\b`, 'i'),
    id,
  ]),
);

export function matchCableByName(text: string): string | null {
  for (const [pattern, id] of _cableNamePatterns) {
    if (pattern.test(text)) return id;
  }
  return null;
}

export function findNearestCable(lat: number, lon: number): { cableId: string; distanceKm: number } | null {
  let bestId: string | null = null;
  let bestDist = Infinity;
  const MAX_DIST_KM = 555; // ~5 degrees at equator

  const cosLat = Math.cos(lat * Math.PI / 180);

  for (const [cableId, landings] of Object.entries(CABLE_LANDINGS)) {
    for (const [lLat, lLon] of landings) {
      const dLat = (lat - lLat) * 111;
      const dLon = (lon - lLon) * 111 * cosLat;
      const distKm = Math.sqrt(dLat ** 2 + dLon ** 2);
      if (distKm < bestDist && distKm < MAX_DIST_KM) {
        bestDist = distKm;
        bestId = cableId;
      }
    }
  }

  return bestId ? { cableId: bestId, distanceKm: bestDist } : null;
}

const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export function parseIssueDate(dateStr: string | undefined): number {
  const m = dateStr?.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!m) return 0;
  const d = new Date(Date.UTC(
    parseInt(m[4]!, 10),
    MONTH_MAP[m[3]!.toUpperCase()] ?? 0,
    parseInt(m[1]!, 10),
    parseInt(m[2]!.slice(0, 2), 10),
    parseInt(m[2]!.slice(2, 4), 10),
  ));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function hasShipName(text: string): boolean {
  return SHIP_PATTERNS.some((pat) => pat.test(text));
}

// ========================================================================
// Signal processing
// ========================================================================

export function processNgaSignals(warnings: NgaWarning[]): Signal[] {
  const signals: Signal[] = [];
  const cableWarnings = warnings.filter((w) => isCableRelated(w.text || ''));

  for (const warning of cableWarnings) {
    const text = warning.text || '';
    const ts = parseIssueDate(warning.issueDate);
    const coords = parseCoordinates(text);

    let cableId = matchCableByName(text);
    let joinMethod = 'name';
    let distanceKm = 0;

    if (!cableId && coords.length > 0) {
      const centLat = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const centLon = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      const nearest = findNearestCable(centLat, centLon);
      if (nearest) {
        cableId = nearest.cableId;
        joinMethod = 'geometry';
        distanceKm = Math.round(nearest.distanceKm);
      }
    }

    if (!cableId) continue;

    const isFault = FAULT_KEYWORDS.test(text);
    const isRepairShip = hasShipName(text);
    const isOnStation = ON_STATION_RE.test(text);

    const summaryText = text.slice(0, 150) + (text.length > 150 ? '...' : '');

    if (isFault) {
      signals.push({
        cableId,
        ts,
        severity: 1.0,
        confidence: joinMethod === 'name' ? 0.9 : Math.max(0.4, 0.8 - distanceKm / 500),
        ttlSeconds: 5 * 86400,
        kind: 'operator_fault',
        evidence: [{ source: 'NGA', summary: `Fault/damage reported: ${summaryText}`, ts }],
      });
    } else {
      signals.push({
        cableId,
        ts,
        severity: 0.6,
        confidence: joinMethod === 'name' ? 0.8 : Math.max(0.3, 0.7 - distanceKm / 500),
        ttlSeconds: 3 * 86400,
        kind: 'cable_advisory',
        evidence: [{ source: 'NGA', summary: `Cable advisory: ${summaryText}`, ts }],
      });
    }

    if (isRepairShip) {
      signals.push({
        cableId,
        ts,
        severity: isOnStation ? 0.8 : 0.5,
        confidence: isOnStation ? 0.85 : 0.6,
        ttlSeconds: isOnStation ? 24 * 3600 : 12 * 3600,
        kind: 'repair_activity',
        evidence: [{
          source: 'NGA',
          summary: isOnStation
            ? `Cable repair vessel on station: ${summaryText}`
            : `Cable ship in area: ${summaryText}`,
          ts,
        }],
      });
    }
  }

  return signals;
}

// ========================================================================
// Health computation
// ========================================================================

export function computeHealthMap(signals: Signal[]): Record<string, CableHealthRecord> {
  const now = Date.now();
  const byCable: Record<string, Signal[]> = {};

  for (const sig of signals) {
    if (!byCable[sig.cableId]) byCable[sig.cableId] = [];
    byCable[sig.cableId]!.push(sig);
  }

  const healthMap: Record<string, CableHealthRecord> = {};

  for (const [cableId, cableSignals] of Object.entries(byCable)) {
    const effectiveSignals: Array<Signal & { effective: number; recencyWeight: number }> = [];

    for (const sig of cableSignals) {
      const ageMs = now - sig.ts;
      const ageSec = Math.max(0, ageMs / 1000);
      const recencyWeight = Math.max(0, Math.min(1, 1 - ageSec / sig.ttlSeconds));

      if (recencyWeight <= 0) continue;

      const effective = sig.severity * sig.confidence * recencyWeight;
      effectiveSignals.push({ ...sig, effective, recencyWeight });
    }

    if (effectiveSignals.length === 0) continue;

    effectiveSignals.sort((a, b) => b.effective - a.effective);

    const topScore = effectiveSignals[0]!.effective;
    const topConfidence = effectiveSignals[0]!.confidence * effectiveSignals[0]!.recencyWeight;

    const hasOperatorFault = effectiveSignals.some(
      (s) => s.kind === 'operator_fault' && s.effective >= 0.50,
    );
    const hasRepairActivity = effectiveSignals.some(
      (s) => s.kind === 'repair_activity' && s.effective >= 0.40,
    );

    let status: CableHealthStatus;
    if (topScore >= 0.80 && hasOperatorFault) {
      status = 'CABLE_HEALTH_STATUS_FAULT';
    } else if (topScore >= 0.80 && hasRepairActivity) {
      status = 'CABLE_HEALTH_STATUS_DEGRADED';
    } else if (topScore >= 0.50) {
      status = 'CABLE_HEALTH_STATUS_DEGRADED';
    } else {
      status = 'CABLE_HEALTH_STATUS_OK';
    }

    const evidence: CableHealthEvidence[] = effectiveSignals
      .slice(0, 3)
      .flatMap((s) => s.evidence)
      .slice(0, 3);

    const lastUpdated = effectiveSignals
      .map((s) => s.ts)
      .sort((a, b) => b - a)[0]!;

    healthMap[cableId] = {
      status,
      score: Math.round(topScore * 100) / 100,
      confidence: Math.round(topConfidence * 100) / 100,
      lastUpdated,
      evidence,
    };
  }

  return healthMap;
}

// ========================================================================
// RPC implementation
// ========================================================================

/**
 * What seed-meta should say about a response we are about to serve, or null
 * when there is nothing to say.
 *
 * seed-meta carries the age of the DATA, not the age of the serve. Both write
 * sites used to stamp Date.now(), so every 30-minute warm-ping re-dated the
 * same stale map and cable-health reported fresh for as long as NGA stayed
 * down — there was no window in which it could report a problem. Dating from
 * generatedAt lets freshness age honestly while the writeback below keeps the
 * canonical key populated, which is the EMPTY alarm that writeback exists for.
 *
 * Null means write nothing. Having never computed a map is not a measurement
 * of zero cables, and the placeholder the client gets in that case would have
 * claimed exactly that.
 */
export function cableHealthSeedMeta(
  response: GetCableHealthResponse | null,
  now: number,
): { fetchedAt: number; recordCount: number } | null {
  if (!response) return null;
  return {
    fetchedAt: response.generatedAt || now,
    recordCount: response.cables ? Object.keys(response.cables).length : 0,
  };
}

/**
 * Build a fresh map from the cached NGA warnings, or null when there is
 * nothing to build from.
 *
 * NGA raw warnings are cached 24h — expensive upstream call, data stable
 * between pings. null from fetchNgaWarnings means the fetch failed;
 * cachedFetchJson stores a sentinel (2 min) and returns null, so this returns
 * null too and the caller leaves cable-health-v1 alone, serving the previous
 * valid response from fallbackCache.
 */
async function computeCableHealth(): Promise<GetCableHealthResponse | null> {
  const ngaData = await cachedFetchJson<NgaWarning[]>(NGA_CACHE_KEY, NGA_CACHE_TTL, fetchNgaWarnings);
  if (ngaData === null) return null;
  const signals = processNgaSignals(ngaData);
  const cables = computeHealthMap(signals);

  return { generatedAt: Date.now(), cables };
}

export async function getCableHealth(
  _ctx: ServerContext,
  _req: GetCableHealthRequest,
): Promise<GetCableHealthResponse> {
  try {
    let result = await cachedFetchJson<GetCableHealthResponse>(CACHE_KEY, CACHE_TTL, computeCableHealth);

    // Serve-for-2h, rebuild-every-45min. Without this the map is only rebuilt
    // when the key expires, which is slower than the bound health.js judges it
    // by; see REFRESH_AFTER_MS. A failed rebuild keeps the map we already have
    // rather than replacing it with nothing.
    if (result && Date.now() - (result.generatedAt || 0) > REFRESH_AFTER_MS) {
      const rebuilt = await computeCableHealth();
      if (rebuilt) {
        await setCachedJson(CACHE_KEY, rebuilt, CACHE_TTL).catch(() => {});
        result = rebuilt;
      }
    }

    if (result) {
      // Dated from the response, not from this serve. A cache hit is up to
      // CACHE_TTL old and says so; health.js allows 90 minutes and raises
      // STALE_SEED past that, which is the honest reading of a map we are still
      // serving but have not recomputed. recordCount reflects the
      // actual cable count — a previous Math.max(count, 1) misrepresented empty
      // responses as having 1 record, and the writeback path below is what
      // keeps the canonical key populated (strlen > 10) so health.js reads
      // hasData=true without needing a fake recordCount floor.
      // Awaited, not floated. This line used to end in `.catch(() => {})` with
      // nothing holding the promise, so the isolate was free to drop the write
      // the moment the response returned. It never threw and never logged; the
      // only symptom was seed-meta frozen at an old fetchedAt while serves kept
      // running the line. ServerContext carries no waitUntil to hand it to, so
      // the response waits on one Redis write instead.
      const meta = cableHealthSeedMeta(result, Date.now());
      if (meta) await setCachedJson('seed-meta:cable-health', meta, 604800).catch(() => {});
      fallbackCache = result;
      return result;
    }

    // NGA upstream failed (cachedFetchJson stored NEG_SENTINEL in cable-health-v1
    // for 2 min). Without writeback, api/health.js sees strlen=10 (NEG_SENTINEL
    // length) → strlenIsData=false → records=0 → EMPTY alarm even though we're
    // serving a valid fallbackCache response to the client. Refresh both the
    // canonical key AND seed-meta with fallbackCache so health reflects the
    // response the user is actually receiving. Short TTL (matches NEG_SENTINEL)
    // so a recovered NGA fetch can immediately overwrite with fresh data — a
    // long one here would be read as a cache hit above and suppress the retry
    // for the whole window. Reaching this line at all means CACHE_TTL has
    // already expired, so seed-meta is past 90 minutes and health.js reports
    // STALE_SEED rather than reading the gaps between these 120s writes as EMPTY.
    const meta = cableHealthSeedMeta(fallbackCache, Date.now());
    if (fallbackCache && meta) {
      await setCachedJson(CACHE_KEY, fallbackCache, 120).catch(() => {});
      await setCachedJson('seed-meta:cable-health', meta, 604800).catch(() => {});
      console.warn(
        `[cable-health] NGA upstream failed; serving a map computed ${Math.round((Date.now() - meta.fetchedAt) / 60000)} min ago`,
      );
      return fallbackCache;
    }
    // Nothing has ever been computed in this isolate. The client still gets an
    // empty map, but writing seed-meta for it would claim a fresh measurement
    // of zero cables, which is the shape of a healthy sea.
    console.warn('[cable-health] NGA upstream failed with no previous map to serve');
    return { generatedAt: Date.now(), cables: {} };
  } catch (err) {
    // Was a bare `catch {}`. It returned the fallback with HTTP 200 and logged
    // nothing, so a Redis outage and a healthy cable map were the same event
    // from outside. seed-meta is deliberately left alone here: this path
    // publishes no new reading, so freshness should keep ageing.
    console.warn(`[cable-health] failed: ${err instanceof Error ? err.message : String(err)}`);
    if (fallbackCache) return fallbackCache;
    return { generatedAt: Date.now(), cables: {} };
  }
}
