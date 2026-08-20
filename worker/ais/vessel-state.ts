/**
 * Pure aggregation state for the AIS relay, ported from scripts/ais-relay.cjs.
 * Nothing here touches ctx.storage or the outbound WebSocket -- worker/ais/
 * relay-do.ts holds the one RelayState instance and calls into this module on
 * every upstream message and on every alarm tick.
 *
 * Deliberate divergence from the original script: none of this state is
 * persisted. It re-populates from live broadcasts within seconds of a
 * reconnect, and persisting a cache that turns over every 2-10 seconds would
 * cost far more in storage writes than it would save.
 *
 * MMSI is the key everywhere and it is a STRING, matching the source: every
 * write site there goes through `String(meta.MMSI || '')`, and the
 * transitPendingEntry sweep in cleanupAggregates splits a
 * `mmsi:chokepointName` key back apart and looks the string half up in
 * vesselChokepoints. Numeric keys would break that lookup with no error.
 */

/**
 * Chokepoint centres and radii, ported verbatim from
 * scripts/ais-relay.cjs:7328. `radius` is in DEGREES and is compared squared
 * against a squared degree offset -- not kilometres, and not a great-circle
 * distance. The comparison is cheap and wrong near the poles; every chokepoint
 * here sits well away from them, and matching the source exactly matters more
 * than the accuracy, because the same radius doubles as the congestion
 * baseline in detectDisruptions (`radius * 10`).
 */
export const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, radius: 2 },
  { name: 'Suez Canal', lat: 30.0, lon: 32.5, radius: 1 },
  { name: 'Malacca Strait', lat: 2.5, lon: 101.5, radius: 2 },
  { name: 'Bab el-Mandeb Strait', lat: 12.5, lon: 43.5, radius: 1.5 },
  { name: 'Panama Canal', lat: 9.0, lon: -79.5, radius: 1 },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radius: 2 },
  { name: 'South China Sea', lat: 15.0, lon: 115.0, radius: 5 },
  { name: 'Black Sea', lat: 43.5, lon: 34.0, radius: 3 },
  { name: 'Cape of Good Hope', lat: -34.36, lon: 18.49, radius: 2 },
  { name: 'Gibraltar Strait', lat: 35.96, lon: -5.35, radius: 1 },
  { name: 'Bosporus Strait', lat: 40.7, lon: 28.0, radius: 1.5 },
  { name: 'Korea Strait', lat: 34.0, lon: 129.0, radius: 1.5 },
  { name: 'Dover Strait', lat: 51.05, lon: 1.45, radius: 0.5 },
  { name: 'Kerch Strait', lat: 45.33, lon: 36.6, radius: 0.5 },
  { name: 'Lombok Strait', lat: -8.47, lon: 115.72, radius: 0.5 },
] as const;

const GRID_SIZE = 2;
const DENSITY_WINDOW = 30 * 60 * 1000;
const GAP_THRESHOLD = 60 * 60 * 1000;
const CANDIDATE_RETENTION_MS = 2 * 60 * 60 * 1000;
const VESSEL_META_TTL_MS = 24 * 60 * 60 * 1000;
const TRANSIT_COOLDOWN_MS = 30 * 60 * 1000;
/** Exported: worker/ais/transits-contract.ts reports the window it counted over. */
export const TRANSIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_DWELL_MS = 5 * 60 * 1000;
/** A pending entry this old outlives any real transit; the source clears it
 *  only once the vessel is no longer a member of that chokepoint. */
const PENDING_ENTRY_CUTOFF_MS = 48 * 60 * 60 * 1000;
/** A vessel counts as returning from silence only if its latest fix is this
 *  recent -- otherwise every long-dead vessel would report as a dark ship. */
const DARK_SHIP_RECENCY_MS = 10 * 60 * 1000;
const MIN_CONGESTION_VESSELS = 5;

const MAX_CANDIDATE_REPORTS = 1_500;
const MAX_DENSITY_ZONES = 200;
const MAX_TANKER_REPORTS_PER_RESPONSE = 200;
const MAX_DENSITY_CELLS = 5_000;
const MAX_VESSEL_META = 50_000;
// The source reads these two from AIS_MAX_VESSELS / AIS_MAX_VESSEL_HISTORY
// with a 20_000 default. A Worker has no process.env, and no deploy ever set
// either variable, so they are plain constants here at the same default.
const MAX_VESSELS = 20_000;
const MAX_VESSEL_HISTORY = 20_000;

// The four caps the source is missing. chokepointBuckets needs none: it is
// keyed by one of 15 hardcoded chokepoint names and cannot grow past 15
// entries. vesselChokepoints and the two transit maps are keyed by MMSI or by
// a composite `mmsi:chokepointName` and have no natural bound.
export const MAX_VESSEL_CHOKEPOINTS = 20_000;
export const MAX_TRANSIT_COOLDOWNS = 50_000;
export const MAX_TRANSIT_PENDING_ENTRY = 50_000;
// chokepointCrossings' keys are bounded, but its VALUES are arrays that the
// source only age-filters, never length-caps. This is an array trim, a
// different eviction shape from the three Map caps above.
export const MAX_CROSSINGS_PER_CHOKEPOINT = 5_000;

const NAVAL_PREFIX_RE = /^(USS|USNS|HMS|HMAS|HMCS|INS|JS|ROKS|TCG|FS|BNS|RFS|PLAN|PLA|CGC|PNS|KRI|ITS|SNS|MMSI)/i;

export type VesselClass = 'tanker' | 'cargo' | 'other';

export function classifyVesselType(shipType: number | undefined): VesselClass {
  if (shipType !== undefined && shipType >= 80 && shipType <= 89) return 'tanker';
  if (shipType !== undefined && shipType >= 70 && shipType <= 79) return 'cargo';
  return 'other';
}

export interface VesselRecord {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  shipType?: number;
  heading?: number;
  speed?: number;
  course?: number;
  timestamp: number;
}

interface VesselMetaRecord {
  shipType: number;
  shipName: string;
  lastSeen: number;
}

/** The cell carries its own centre point because calculateDensityZones
 *  reports centres, not the grid corner encoded in the map key. */
interface DensityCell {
  lat: number;
  lon: number;
  vessels: Set<string>;
  lastUpdate: number;
  previousCount: number;
}

export interface VesselReport {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  shipType?: number;
  heading?: number;
  speed?: number;
  course?: number;
  timestamp: number;
}

export interface ChokepointCrossing {
  mmsi: string;
  type: VesselClass;
  ts: number;
}

export interface RelayState {
  vessels: Map<string, VesselRecord>;
  /** MMSI to the timestamps of its last 10 fixes. Positions are not kept --
   *  detectDisruptions only measures the gap between consecutive fixes. */
  vesselHistory: Map<string, number[]>;
  vesselMeta: Map<string, VesselMetaRecord>;
  densityGrid: Map<string, DensityCell>;
  candidateReports: Map<string, VesselReport>;
  tankerReports: Map<string, VesselReport>;
  chokepointBuckets: Map<string, Set<string>>;
  vesselChokepoints: Map<string, Set<string>>;
  transitCooldowns: Map<string, number>;
  transitPendingEntry: Map<string, number>;
  chokepointCrossings: Map<string, ChokepointCrossing[]>;
  messageCount: number;
  droppedMessages: number;
}

export function createRelayState(): RelayState {
  return {
    vessels: new Map(),
    vesselHistory: new Map(),
    vesselMeta: new Map(),
    densityGrid: new Map(),
    candidateReports: new Map(),
    tankerReports: new Map(),
    chokepointBuckets: new Map(),
    vesselChokepoints: new Map(),
    transitCooldowns: new Map(),
    transitPendingEntry: new Map(),
    chokepointCrossings: new Map(),
    messageCount: 0,
    droppedMessages: 0,
  };
}

/** Size-cap eviction: deletes the oldest entries (by getTimestamp) until the
 *  map is at or under maxSize. */
function evictMapByTimestamp<K, V>(map: Map<K, V>, maxSize: number, getTimestamp: (v: V) => number): void {
  if (map.size <= maxSize) return;
  const sorted = [...map.entries()].sort((a, b) => {
    const tsA = Number(getTimestamp(a[1])) || 0;
    const tsB = Number(getTimestamp(b[1])) || 0;
    return tsA - tsB;
  });
  for (const [key] of sorted.slice(0, map.size - maxSize)) map.delete(key);
}

function getGridKey(lat: number, lon: number): string {
  const gridLat = Math.floor(lat / GRID_SIZE) * GRID_SIZE;
  const gridLon = Math.floor(lon / GRID_SIZE) * GRID_SIZE;
  return `${gridLat},${gridLon}`;
}

interface AisMetaData {
  MMSI?: number | string;
  latitude?: number;
  longitude?: number;
  ShipName?: string;
  ShipType?: number;
}

/**
 * The type arm comes first so a PositionReport caller -- whose MetaData never
 * carries ShipType -- still reaches it through the resolved cache value
 * instead of falling back to the name and MMSI-suffix heuristics alone.
 */
function isLikelyMilitaryCandidate(meta: AisMetaData | undefined, resolvedShipType: number | undefined): boolean {
  const mmsi = String(meta?.MMSI ?? '');
  const shipType = Number.isFinite(Number(resolvedShipType)) ? Number(resolvedShipType) : Number(meta?.ShipType);
  const name = (meta?.ShipName ?? '').trim().toUpperCase();

  if (Number.isFinite(shipType) && (shipType === 35 || shipType === 55 || (shipType >= 50 && shipType <= 59))) {
    return true;
  }
  if (name && NAVAL_PREFIX_RE.test(name)) return true;
  if (mmsi.length >= 9) {
    const suffix = mmsi.substring(3);
    if (suffix.startsWith('00') || suffix.startsWith('99')) return true;
  }
  return false;
}

export function removeVesselFromChokepoints(state: RelayState, mmsi: string): void {
  const previous = state.vesselChokepoints.get(mmsi);
  if (!previous) return;

  for (const cpName of previous) {
    const bucket = state.chokepointBuckets.get(cpName);
    if (!bucket) continue;
    bucket.delete(mmsi);
    if (bucket.size === 0) state.chokepointBuckets.delete(cpName);
  }
  state.vesselChokepoints.delete(mmsi);
}

/**
 * Recomputes exact chokepoint membership so a moving vessel never stays stuck
 * in an old bucket. A crossing is recorded on EXIT, not entry, and only when
 * the vessel dwelled at least MIN_DWELL_MS and its last crossing of the same
 * chokepoint is outside the cooldown.
 */
export function updateVesselChokepoints(state: RelayState, mmsi: string, lat: number, lon: number, now: number): void {
  const next = new Set<string>();
  for (const cp of CHOKEPOINTS) {
    const dlat = lat - cp.lat;
    const dlon = lon - cp.lon;
    if (dlat * dlat + dlon * dlon <= cp.radius * cp.radius) next.add(cp.name);
  }

  const previous = state.vesselChokepoints.get(mmsi) ?? new Set<string>();

  for (const cpName of previous) {
    if (next.has(cpName)) continue;
    const bucket = state.chokepointBuckets.get(cpName);
    if (!bucket) continue;
    bucket.delete(mmsi);
    if (bucket.size === 0) state.chokepointBuckets.delete(cpName);

    const key = `${mmsi}:${cpName}`;
    const entryTs = state.transitPendingEntry.get(key);
    if (entryTs !== undefined && now - entryTs >= MIN_DWELL_MS) {
      const lastCrossing = state.transitCooldowns.get(key);
      if (!lastCrossing || now - lastCrossing >= TRANSIT_COOLDOWN_MS) {
        const vessel = state.vessels.get(mmsi);
        let crossings = state.chokepointCrossings.get(cpName);
        if (!crossings) {
          crossings = [];
          state.chokepointCrossings.set(cpName, crossings);
        }
        crossings.push({ mmsi, type: classifyVesselType(vessel?.shipType), ts: now });
        state.transitCooldowns.set(key, now);
      }
    }
    state.transitPendingEntry.delete(key);
  }

  for (const cpName of next) {
    if (!previous.has(cpName)) state.transitPendingEntry.set(`${mmsi}:${cpName}`, now);
    let bucket = state.chokepointBuckets.get(cpName);
    if (!bucket) {
      bucket = new Set();
      state.chokepointBuckets.set(cpName, bucket);
    }
    bucket.add(mmsi);
  }

  if (next.size === 0) state.vesselChokepoints.delete(mmsi);
  else state.vesselChokepoints.set(mmsi, next);
}

interface ShipStaticDataFrame {
  MetaData?: AisMetaData;
  Message?: { ShipStaticData?: { Type?: number | null; Name?: string; UserID?: number | string } };
}

/**
 * AISStream Type 5. Carries the ShipType and ShipName that PositionReport
 * frames lack, so this cache is what makes classification work at all.
 *
 * The `shipType > 0` gate is what stops a later `{Type: null}` or AIS code 0
 * ("Not available") broadcast from downgrading a vessel that already reported
 * a real type: the whole write is skipped, name included.
 */
export function processShipStaticData(state: RelayState, data: ShipStaticDataFrame): void {
  const meta = data?.MetaData;
  const sd = data?.Message?.ShipStaticData;
  if (!meta || !sd) return;

  // MetaData.MMSI is the documented wrapper field; the message body mirrors it
  // as UserID. Reading both means a wrapper schema variant cannot silently
  // re-empty vesselMeta.
  const mmsi = String(meta.MMSI ?? sd.UserID ?? '');
  if (!mmsi) return;

  const shipType = Number(sd.Type);
  if (!Number.isFinite(shipType) || shipType <= 0) return;

  state.vesselMeta.set(mmsi, {
    shipType,
    shipName: (sd.Name || meta.ShipName || '').trim(),
    lastSeen: Date.now(),
  });
}

interface PositionReportFrame {
  MetaData?: AisMetaData;
  Message?: {
    PositionReport?: {
      Latitude?: number;
      Longitude?: number;
      Sog?: number;
      Cog?: number;
      TrueHeading?: number;
    };
  };
}

export function processPositionReport(state: RelayState, data: PositionReportFrame): void {
  const meta = data?.MetaData;
  const pos = data?.Message?.PositionReport;
  if (!meta || !pos) return;

  const mmsi = String(meta.MMSI ?? '');
  if (!mmsi) return;

  const lat = Number.isFinite(pos.Latitude) ? (pos.Latitude as number) : (meta.latitude as number);
  const lon = Number.isFinite(pos.Longitude) ? (pos.Longitude as number) : (meta.longitude as number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const now = Date.now();

  // Resolve ShipType once and feed every consumer below from it. AISStream's
  // PositionReport MetaData does not carry the field; it only arrives on Type 5
  // frames cached in vesselMeta. Reading meta.ShipType per consumer left
  // vessels[mmsi].shipType undefined, which silently made every chokepoint
  // transit classify as 'other'.
  const cachedMeta = state.vesselMeta.get(mmsi);
  const effectiveShipType = Number.isFinite(Number(meta.ShipType)) ? Number(meta.ShipType) : cachedMeta?.shipType;

  state.vessels.set(mmsi, {
    mmsi,
    name: meta.ShipName || cachedMeta?.shipName || '',
    lat,
    lon,
    timestamp: now,
    shipType: effectiveShipType,
    heading: pos.TrueHeading,
    speed: pos.Sog,
    course: pos.Cog,
  });

  const history = state.vesselHistory.get(mmsi) ?? [];
  history.push(now);
  if (history.length > 10) history.shift();
  state.vesselHistory.set(mmsi, history);

  const gridKey = getGridKey(lat, lon);
  let cell = state.densityGrid.get(gridKey);
  if (!cell) {
    cell = {
      lat: Math.floor(lat / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      lon: Math.floor(lon / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      vessels: new Set(),
      lastUpdate: now,
      previousCount: 0,
    };
    state.densityGrid.set(gridKey, cell);
  }
  cell.vessels.add(mmsi);
  cell.lastUpdate = now;

  updateVesselChokepoints(state, mmsi, lat, lon, now);

  if (isLikelyMilitaryCandidate(meta, effectiveShipType)) {
    state.candidateReports.set(mmsi, {
      mmsi,
      name: meta.ShipName || cachedMeta?.shipName || '',
      lat,
      lon,
      shipType: effectiveShipType,
      heading: pos.TrueHeading,
      speed: pos.Sog,
      course: pos.Cog,
      timestamp: now,
    });
  }

  // AIS ship type 80-89 covers every tanker subtype per ITU-R M.1371. Kept in
  // its own map so the military-detection consumer never sees tankers.
  const shipType = Number.isFinite(Number(effectiveShipType)) ? Number(effectiveShipType) : NaN;
  if (Number.isFinite(shipType) && shipType >= 80 && shipType <= 89) {
    state.tankerReports.set(mmsi, {
      mmsi,
      name: cachedMeta?.shipName || meta.ShipName || '',
      lat,
      lon,
      shipType,
      heading: pos.TrueHeading,
      speed: pos.Sog,
      course: pos.Cog,
      timestamp: now,
    });
  }
}

export function cleanupAggregates(state: RelayState, now: number): void {
  const cutoff = now - DENSITY_WINDOW;

  for (const [mmsi, vessel] of state.vessels) {
    if (vessel.timestamp < cutoff) {
      state.vessels.delete(mmsi);
      removeVesselFromChokepoints(state, mmsi);
    }
  }
  // Not evictMapByTimestamp: an evicted vessel also has to be unhooked from
  // every chokepoint bucket it still sits in, or the orphan inflates
  // detectDisruptions's vesselCount for good.
  if (state.vessels.size > MAX_VESSELS) {
    const sorted = [...state.vessels.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (const [mmsi] of sorted.slice(0, state.vessels.size - MAX_VESSELS)) {
      state.vessels.delete(mmsi);
      removeVesselFromChokepoints(state, mmsi);
    }
  }

  for (const [mmsi, history] of state.vesselHistory) {
    const filtered = history.filter((ts) => ts >= cutoff);
    if (filtered.length === 0) state.vesselHistory.delete(mmsi);
    else state.vesselHistory.set(mmsi, filtered);
  }
  evictMapByTimestamp(state.vesselHistory, MAX_VESSEL_HISTORY, (history) => history[history.length - 1] || 0);

  for (const [key, cell] of state.densityGrid) {
    cell.previousCount = cell.vessels.size;
    for (const mmsi of cell.vessels) {
      const vessel = state.vessels.get(mmsi);
      if (!vessel || vessel.timestamp < cutoff) cell.vessels.delete(mmsi);
    }
    if (cell.vessels.size === 0 && now - cell.lastUpdate > DENSITY_WINDOW * 2) state.densityGrid.delete(key);
  }
  evictMapByTimestamp(state.densityGrid, MAX_DENSITY_CELLS, (cell) => cell.lastUpdate || 0);

  for (const [mmsi, report] of state.candidateReports) {
    if (report.timestamp < now - CANDIDATE_RETENTION_MS) state.candidateReports.delete(mmsi);
  }
  evictMapByTimestamp(state.candidateReports, MAX_CANDIDATE_REPORTS, (report) => report.timestamp || 0);

  // Same retention as candidates: a vessel with no fix in two hours is no
  // longer useful to a live map layer. The cap is 10x the per-response slice
  // so bbox filtering still finds recent fixes anywhere on the globe.
  for (const [mmsi, report] of state.tankerReports) {
    if (report.timestamp < now - CANDIDATE_RETENTION_MS) state.tankerReports.delete(mmsi);
  }
  evictMapByTimestamp(state.tankerReports, MAX_TANKER_REPORTS_PER_RESPONSE * 10, (report) => report.timestamp || 0);

  // ShipStaticData is rebroadcast about every 6 minutes, so a 24h TTL covers
  // vessels with intermittent visibility.
  for (const [mmsi, entry] of state.vesselMeta) {
    if (entry.lastSeen < now - VESSEL_META_TTL_MS) state.vesselMeta.delete(mmsi);
  }
  evictMapByTimestamp(state.vesselMeta, MAX_VESSEL_META, (entry) => entry.lastSeen || 0);

  for (const [cpName, bucket] of state.chokepointBuckets) {
    for (const mmsi of bucket) {
      if (state.vessels.has(mmsi)) continue;
      bucket.delete(mmsi);
      const memberships = state.vesselChokepoints.get(mmsi);
      if (memberships) {
        memberships.delete(cpName);
        if (memberships.size === 0) state.vesselChokepoints.delete(mmsi);
      }
    }
    if (bucket.size === 0) state.chokepointBuckets.delete(cpName);
  }

  for (const [cpName, crossings] of state.chokepointCrossings) {
    const inWindow = crossings.filter((c) => now - c.ts < TRANSIT_WINDOW_MS);
    if (inWindow.length === 0) {
      state.chokepointCrossings.delete(cpName);
      continue;
    }
    // New cap: the source age-filters this array but never bounds its length.
    // Keep the head, which is the freshest -- crossings are pushed in arrival
    // order, so the tail is the oldest.
    state.chokepointCrossings.set(
      cpName,
      inWindow.length > MAX_CROSSINGS_PER_CHOKEPOINT ? inWindow.slice(0, MAX_CROSSINGS_PER_CHOKEPOINT) : inWindow,
    );
  }

  for (const [key, ts] of state.transitCooldowns) {
    if (now - ts > TRANSIT_COOLDOWN_MS) state.transitCooldowns.delete(key);
  }
  for (const [key, ts] of state.transitPendingEntry) {
    if (now - ts > PENDING_ENTRY_CUTOFF_MS) {
      const sep = key.indexOf(':');
      const memberships = state.vesselChokepoints.get(key.substring(0, sep));
      if (!memberships || !memberships.has(key.substring(sep + 1))) state.transitPendingEntry.delete(key);
    }
  }

  // The three remaining new caps. vesselChokepoints cannot go through
  // evictMapByTimestamp for two reasons: its value is a Set of chokepoint
  // names carrying no timestamp, so the age has to come from state.vessels
  // under the same key; and deleting straight from it would leave the evicted
  // mmsi behind in every bucket it still belonged to.
  if (state.vesselChokepoints.size > MAX_VESSEL_CHOKEPOINTS) {
    const byAge = [...state.vesselChokepoints.keys()]
      .map((mmsi) => ({ mmsi, timestamp: state.vessels.get(mmsi)?.timestamp ?? 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const { mmsi } of byAge.slice(0, byAge.length - MAX_VESSEL_CHOKEPOINTS)) {
      removeVesselFromChokepoints(state, mmsi);
    }
  }
  evictMapByTimestamp(state.transitCooldowns, MAX_TRANSIT_COOLDOWNS, (ts) => ts);
  evictMapByTimestamp(state.transitPendingEntry, MAX_TRANSIT_PENDING_ENTRY, (ts) => ts);
}

export interface Disruption {
  id: string;
  name: string;
  type: 'chokepoint_congestion' | 'gap_spike';
  lat: number;
  lon: number;
  severity: 'high' | 'elevated' | 'low';
  changePct: number;
  windowHours: number;
  vesselCount?: number;
  region?: string;
  darkShips?: number;
  description: string;
}

export function detectDisruptions(state: RelayState, now: number): Disruption[] {
  const disruptions: Disruption[] = [];

  // O(chokepoints) off the pre-built buckets, not O(chokepoints x vessels).
  for (const chokepoint of CHOKEPOINTS) {
    const vesselCount = state.chokepointBuckets.get(chokepoint.name)?.size ?? 0;
    if (vesselCount < MIN_CONGESTION_VESSELS) continue;

    const normalTraffic = chokepoint.radius * 10;
    disruptions.push({
      id: `chokepoint-${chokepoint.name.toLowerCase().replace(/\s+/g, '-')}`,
      name: chokepoint.name,
      type: 'chokepoint_congestion',
      lat: chokepoint.lat,
      lon: chokepoint.lon,
      severity: vesselCount > normalTraffic * 1.5 ? 'high' : vesselCount > normalTraffic ? 'elevated' : 'low',
      changePct: normalTraffic > 0 ? Math.round((vesselCount / normalTraffic - 1) * 100) : 0,
      windowHours: 1,
      vesselCount,
      region: chokepoint.name,
      description: `${vesselCount} vessels in ${chokepoint.name}`,
    });
  }

  let darkShipCount = 0;
  for (const history of state.vesselHistory.values()) {
    if (history.length < 2) continue;
    const lastSeen = history[history.length - 1];
    const secondLast = history[history.length - 2];
    if (lastSeen === undefined || secondLast === undefined) continue;
    if (lastSeen - secondLast > GAP_THRESHOLD && now - lastSeen < DARK_SHIP_RECENCY_MS) darkShipCount++;
  }

  if (darkShipCount >= 1) {
    disruptions.push({
      id: 'global-gap-spike',
      name: 'AIS Gap Spike Detected',
      type: 'gap_spike',
      lat: 0,
      lon: 0,
      severity: darkShipCount > 20 ? 'high' : darkShipCount > 10 ? 'elevated' : 'low',
      changePct: darkShipCount * 10,
      windowHours: 1,
      darkShips: darkShipCount,
      description: `${darkShipCount} vessels returned after extended AIS silence`,
    });
  }

  return disruptions;
}

export interface DensityZone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  intensity: number;
  deltaPct: number;
  shipsPerDay: number;
  note?: string;
}

export function calculateDensityZones(state: RelayState): DensityZone[] {
  const zones: DensityZone[] = [];
  const populated = [...state.densityGrid.values()].filter((c) => c.vessels.size >= 2);
  if (populated.length === 0) return zones;

  const counts = populated.map((c) => c.vessels.size);
  const logMax = Math.log(Math.max(...counts) + 1);
  const logMin = Math.log(Math.min(...counts) + 1);

  for (const [key, cell] of state.densityGrid) {
    if (cell.vessels.size < 2) continue;
    const logCurrent = Math.log(cell.vessels.size + 1);

    zones.push({
      id: `density-${key}`,
      name: `Zone ${key}`,
      lat: cell.lat,
      lon: cell.lon,
      intensity: logMax > logMin ? 0.2 + (0.8 * (logCurrent - logMin)) / (logMax - logMin) : 0.5,
      deltaPct:
        cell.previousCount > 0
          ? Math.round(((cell.vessels.size - cell.previousCount) / cell.previousCount) * 100)
          : 0,
      shipsPerDay: cell.vessels.size * 48,
      note: cell.vessels.size >= 10 ? 'High traffic area' : undefined,
    });
  }

  return zones.sort((a, b) => b.intensity - a.intensity).slice(0, MAX_DENSITY_ZONES);
}

export function getCandidateReportsSnapshot(state: RelayState): VesselReport[] {
  return [...state.candidateReports.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_CANDIDATE_REPORTS);
}

/** Flat, unlike the source's nested `{sw:{lat,lon}, ne:{lat,lon}}`. The parsed
 *  box never crosses the wire -- only the raw query string does -- so the shape
 *  is internal and the flat one reads better at every call site. */
export interface Bbox {
  swLat: number;
  swLon: number;
  neLat: number;
  neLon: number;
}

/**
 * Parses a `bbox` query param of the form "swLat,swLon,neLat,neLon".
 * Rejects anything that is not four finite numbers, has sw past ne, falls
 * outside real lat/lon range, or spans more than 10 degrees on either axis --
 * the last guard stops one query pulling every vessel on the globe.
 */
export function parseBbox(raw: string | null | undefined): Bbox | null {
  if (!raw) return null;
  const parts = String(raw).split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  // The check above is what makes the cast sound: four entries, every one a
  // finite number. TypeScript's index signature cannot see that.
  const [swLat, swLon, neLat, neLon] = parts as [number, number, number, number];
  if (swLat > neLat || swLon > neLon) return null;
  if (swLat < -90 || neLat > 90 || swLon < -180 || neLon > 180) return null;
  if (neLat - swLat > 10 || neLon - swLon > 10) return null;
  return { swLat, swLon, neLat, neLon };
}

/** Sorted by recency of last fix so the 200-cap keeps the most recently seen
 *  vessels rather than an arbitrary subset. */
export function getTankerReportsSnapshot(state: RelayState, bbox: Bbox | null): VesselReport[] {
  let reports = [...state.tankerReports.values()];
  if (bbox) {
    reports = reports.filter(
      (r) => r.lat >= bbox.swLat && r.lat <= bbox.neLat && r.lon >= bbox.swLon && r.lon <= bbox.neLon,
    );
  }
  return reports.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_TANKER_REPORTS_PER_RESPONSE);
}
