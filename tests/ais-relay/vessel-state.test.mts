import { describe, it, expect } from 'vitest';
import {
  createRelayState,
  processPositionReport,
  processShipStaticData,
  cleanupAggregates,
  detectDisruptions,
  calculateDensityZones,
  getCandidateReportsSnapshot,
  getTankerReportsSnapshot,
  parseBbox,
  MAX_VESSEL_CHOKEPOINTS,
  MAX_CROSSINGS_PER_CHOKEPOINT,
} from '../../worker/ais/vessel-state';

// MMSI keys are strings throughout, matching the source relay: every write
// site there goes through `String(meta.MMSI || '')`, and cleanupAggregates's
// transitPendingEntry sweep splits a `mmsi:chokepointName` key back apart and
// looks the string half up in vesselChokepoints. Numeric keys would break that
// lookup silently.

describe('parseBbox', () => {
  it('parses four comma-separated finite numbers', () => {
    expect(parseBbox('10,20,15,25')).toEqual({ swLat: 10, swLon: 20, neLat: 15, neLon: 25 });
  });

  it('rejects sw > ne', () => {
    expect(parseBbox('15,25,10,20')).toBeNull();
  });

  it('rejects out-of-range latitude', () => {
    expect(parseBbox('-95,20,10,25')).toBeNull();
  });

  it('rejects out-of-range longitude', () => {
    expect(parseBbox('10,-185,15,25')).toBeNull();
  });

  it('rejects a bbox wider than 10 degrees in either dimension', () => {
    expect(parseBbox('0,0,15,15')).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    expect(parseBbox('not,a,valid,bbox')).toBeNull();
    expect(parseBbox('1,2,3')).toBeNull();
    expect(parseBbox(null)).toBeNull();
  });
});

describe('processPositionReport + processShipStaticData', () => {
  it('resolves shipType from the vesselMeta cache when the position report carries none', () => {
    const state = createRelayState();
    // AISStream's PositionReport.MetaData never carries ShipType (PR #3410's
    // bug) -- static data must arrive first and populate the meta cache for
    // classification to work at all.
    processShipStaticData(state, {
      MetaData: { MMSI: 123456789 },
      Message: { ShipStaticData: { Type: 80 } },
    });
    processPositionReport(state, {
      MetaData: { MMSI: 123456789, latitude: 26.5, longitude: 56.3 },
      Message: { PositionReport: { Sog: 12, Cog: 90, TrueHeading: 90 } },
    });
    expect(state.vessels.get('123456789')?.shipType).toBe(80);
  });

  it('a later null ShipType never downgrades a previously cached valid type', () => {
    const state = createRelayState();
    processShipStaticData(state, { MetaData: { MMSI: 42 }, Message: { ShipStaticData: { Type: 80 } } });
    processShipStaticData(state, { MetaData: { MMSI: 42 }, Message: { ShipStaticData: { Type: 0 } } });
    expect(state.vesselMeta.get('42')?.shipType).toBe(80);
  });

  it('tracks a tanker report only for shipType 80-89', () => {
    const state = createRelayState();
    processShipStaticData(state, { MetaData: { MMSI: 7 }, Message: { ShipStaticData: { Type: 84 } } });
    processPositionReport(state, {
      MetaData: { MMSI: 7, latitude: 1, longitude: 1 },
      Message: { PositionReport: { Sog: 5, Cog: 0, TrueHeading: 0 } },
    });
    expect(state.tankerReports.has('7')).toBe(true);
  });

  it('does not track a cargo vessel (shipType 70-79) as a tanker', () => {
    const state = createRelayState();
    processShipStaticData(state, { MetaData: { MMSI: 8 }, Message: { ShipStaticData: { Type: 71 } } });
    processPositionReport(state, {
      MetaData: { MMSI: 8, latitude: 1, longitude: 1 },
      Message: { PositionReport: { Sog: 5, Cog: 0, TrueHeading: 0 } },
    });
    expect(state.tankerReports.has('8')).toBe(false);
  });

  it('prefers PositionReport.Latitude/Longitude over the MetaData fallback', () => {
    const state = createRelayState();
    processPositionReport(state, {
      MetaData: { MMSI: 9, latitude: 1, longitude: 1 },
      Message: { PositionReport: { Latitude: 40, Longitude: -70 } },
    });
    expect(state.vessels.get('9')).toMatchObject({ lat: 40, lon: -70 });
  });

  it('drops a position report with no usable coordinates', () => {
    const state = createRelayState();
    processPositionReport(state, { MetaData: { MMSI: 10 }, Message: { PositionReport: {} } });
    expect(state.vessels.size).toBe(0);
  });

  it('joins the chokepoint bucket for a vessel inside the Strait of Hormuz radius', () => {
    const state = createRelayState();
    // Hormuz sits at 26.5N 56.5E with a 2-degree radius, compared squared and
    // in degrees -- not haversine kilometres.
    processPositionReport(state, {
      MetaData: { MMSI: 11, latitude: 26.5, longitude: 56.5 },
      Message: { PositionReport: { Sog: 1 } },
    });
    expect(state.chokepointBuckets.get('Strait of Hormuz')?.has('11')).toBe(true);
    expect(state.vesselChokepoints.get('11')?.has('Strait of Hormuz')).toBe(true);
    expect(state.transitPendingEntry.has('11:Strait of Hormuz')).toBe(true);
  });

  it('leaves the bucket when the vessel moves outside the radius', () => {
    const state = createRelayState();
    processPositionReport(state, {
      MetaData: { MMSI: 12, latitude: 26.5, longitude: 56.5 },
      Message: { PositionReport: { Sog: 1 } },
    });
    processPositionReport(state, {
      MetaData: { MMSI: 12, latitude: 0, longitude: 0 },
      Message: { PositionReport: { Sog: 1 } },
    });
    expect(state.chokepointBuckets.has('Strait of Hormuz')).toBe(false);
    expect(state.vesselChokepoints.has('12')).toBe(false);
  });
});

describe('cleanupAggregates caps', () => {
  it('leaves vesselChokepoints untouched when below MAX_VESSEL_CHOKEPOINTS', () => {
    const state = createRelayState();
    for (let mmsi = 1; mmsi <= 3; mmsi++) {
      state.vesselChokepoints.set(String(mmsi), new Set(['Strait of Hormuz']));
    }
    expect(state.vesselChokepoints.size).toBe(3);
    cleanupAggregates(state, Date.now());
    expect(state.vesselChokepoints.size).toBe(3);
  });

  it('evicts vesselChokepoints beyond MAX_VESSEL_CHOKEPOINTS, oldest first, and cleans the matching bucket too', () => {
    const state = createRelayState();
    const total = MAX_VESSEL_CHOKEPOINTS + 5;
    // mmsi doubles as both the vessel id and its age: mmsi N has
    // timestamp N, so mmsi 0-4 are the 5 oldest and must be the ones
    // evicted. All of them are also members of the same chokepoint bucket,
    // so this also exercises removeVesselFromChokepoints's bucket-side
    // cleanup, not just the vesselChokepoints map itself.
    //
    // Note: MAX_VESSELS (the cap on state.vessels itself) is also 20_000,
    // the same number as MAX_VESSEL_CHOKEPOINTS, so cleanupAggregates's
    // earlier vessels-eviction step removes these same 5 oldest mmsi from
    // state.vessels first, in the same call. That happens to line up with
    // this test's own expectation (mmsi 0-4 gone from vesselChokepoints
    // too) rather than fight it -- both caps agree on which 5 are oldest.
    const bucket = new Set<string>();
    for (let mmsi = 0; mmsi < total; mmsi++) {
      const key = String(mmsi);
      state.vessels.set(key, { mmsi: key, name: '', lat: 0, lon: 0, timestamp: mmsi });
      state.vesselChokepoints.set(key, new Set(['Strait of Hormuz']));
      bucket.add(key);
    }
    state.chokepointBuckets.set('Strait of Hormuz', bucket);
    expect(state.vesselChokepoints.size).toBe(total);

    // `now` is `total`, so no vessel is older than the 30-minute age cutoff
    // and only the size caps do any work.
    cleanupAggregates(state, total);

    expect(state.vesselChokepoints.size).toBe(MAX_VESSEL_CHOKEPOINTS);
    for (let mmsi = 0; mmsi < 5; mmsi++) {
      expect(state.vesselChokepoints.has(String(mmsi))).toBe(false);
      expect(state.chokepointBuckets.get('Strait of Hormuz')?.has(String(mmsi))).toBe(false);
    }
    expect(state.vesselChokepoints.has('5')).toBe(true);
  });

  it('trims chokepointCrossings arrays to MAX_CROSSINGS_PER_CHOKEPOINT', () => {
    const state = createRelayState();
    const now = Date.now();
    const many = Array.from({ length: MAX_CROSSINGS_PER_CHOKEPOINT + 10 }, (_, i) => ({
      mmsi: String(i),
      type: 'tanker' as const,
      ts: now - i, // strictly increasing age, oldest at the end
    }));
    state.chokepointCrossings.set('Strait of Hormuz', many);
    cleanupAggregates(state, now);
    const trimmed = state.chokepointCrossings.get('Strait of Hormuz') ?? [];
    expect(trimmed.length).toBe(MAX_CROSSINGS_PER_CHOKEPOINT);
    // Keeps the freshest, drops the oldest tail.
    expect(trimmed[0]?.mmsi).toBe('0');
  });

  it('drops vessels older than the density window and unhooks them from chokepoints', () => {
    const state = createRelayState();
    const now = Date.now();
    state.vessels.set('1', { mmsi: '1', name: '', lat: 0, lon: 0, timestamp: now - 60 * 60 * 1000 });
    state.vesselChokepoints.set('1', new Set(['Suez Canal']));
    state.chokepointBuckets.set('Suez Canal', new Set(['1']));
    cleanupAggregates(state, now);
    expect(state.vessels.size).toBe(0);
    expect(state.vesselChokepoints.size).toBe(0);
    expect(state.chokepointBuckets.size).toBe(0);
  });
});

describe('detectDisruptions', () => {
  it('returns an empty array when there is no congestion and no gap spike', () => {
    const state = createRelayState();
    expect(detectDisruptions(state, Date.now())).toEqual([]);
  });

  it('ignores a chokepoint holding fewer than 5 vessels', () => {
    const state = createRelayState();
    state.chokepointBuckets.set('Suez Canal', new Set(['1', '2', '3', '4']));
    expect(detectDisruptions(state, Date.now())).toEqual([]);
  });

  it('reports congestion once a chokepoint holds 5 or more vessels', () => {
    const state = createRelayState();
    state.chokepointBuckets.set('Suez Canal', new Set(['1', '2', '3', '4', '5']));
    const [disruption] = detectDisruptions(state, Date.now());
    expect(disruption).toMatchObject({
      id: 'chokepoint-suez-canal',
      type: 'chokepoint_congestion',
      vesselCount: 5,
    });
  });

  it('counts a vessel that returned after an AIS gap as a dark ship', () => {
    const state = createRelayState();
    const now = Date.now();
    // Two fixes over 2 hours apart, the later one inside the last 10 minutes.
    state.vesselHistory.set('1', [now - 2 * 60 * 60 * 1000, now - 60_000]);
    const spike = detectDisruptions(state, now).find((d) => d.type === 'gap_spike');
    expect(spike).toMatchObject({ id: 'global-gap-spike', darkShips: 1 });
  });
});

describe('calculateDensityZones', () => {
  it('excludes cells with fewer than 2 vessels', () => {
    const state = createRelayState();
    expect(calculateDensityZones(state)).toEqual([]);
    state.densityGrid.set('0,0', {
      lat: 1,
      lon: 1,
      vessels: new Set(['1']),
      lastUpdate: Date.now(),
      previousCount: 0,
    });
    expect(calculateDensityZones(state)).toEqual([]);
  });

  it('reports a cell centre, not the raw grid corner, once 2 vessels are in it', () => {
    const state = createRelayState();
    state.densityGrid.set('0,0', {
      lat: 1,
      lon: 1,
      vessels: new Set(['1', '2']),
      lastUpdate: Date.now(),
      previousCount: 0,
    });
    expect(calculateDensityZones(state)).toEqual([
      { id: 'density-0,0', name: 'Zone 0,0', lat: 1, lon: 1, intensity: 0.5, deltaPct: 0, shipsPerDay: 96, note: undefined },
    ]);
  });
});

describe('getCandidateReportsSnapshot / getTankerReportsSnapshot', () => {
  it('returns an empty array when nothing has been tracked', () => {
    const state = createRelayState();
    expect(getCandidateReportsSnapshot(state)).toEqual([]);
    expect(getTankerReportsSnapshot(state, null)).toEqual([]);
  });

  it('filters tanker reports to the bbox when one is given', () => {
    const state = createRelayState();
    const now = Date.now();
    state.tankerReports.set('1', { mmsi: '1', name: '', lat: 12, lon: 22, shipType: 80, timestamp: now });
    state.tankerReports.set('2', { mmsi: '2', name: '', lat: 50, lon: 50, shipType: 80, timestamp: now });
    const inside = getTankerReportsSnapshot(state, { swLat: 10, swLon: 20, neLat: 15, neLon: 25 });
    expect(inside.map((r) => r.mmsi)).toEqual(['1']);
  });
});
