import { CHOKEPOINTS, TRANSIT_WINDOW_MS, type RelayState } from './vessel-state';

/**
 * The wire shape of `GET /ais/transits`.
 *
 * Ported from seedChokepointTransits() in the old Node relay
 * (scripts/ais-relay.cjs line 8012), which read the same in-memory crossing
 * arrays and wrote them straight to Redis. Here the counting and the writing
 * split across the network: this Durable Object holds the crossings, and
 * scripts/seed-transit-summaries.mjs runs in a container and does the writing.
 *
 * `transits` is keyed by relay geofence name, not canonical chokepoint id, and
 * covers all 15 fences -- including South China Sea and Black Sea, which are
 * seas rather than chokepoints. That is what the relay wrote to
 * supply_chain:chokepoint_transits:v1 and what its consumers still read. The
 * seed script owns the mapping onto the 13 canonical ids.
 */
export interface TransitCounts {
  tanker: number;
  cargo: number;
  other: number;
  total: number;
}

export interface TransitsResponse {
  transits: Record<string, TransitCounts>;
  fetchedAt: number;
  windowHours: number;
  /**
   * Whether the upstream AIS socket is open right now.
   *
   * A dead feed and a genuinely quiet strait both count zero crossings, and the
   * seed script must not publish the first as the second. Without this field
   * the difference is invisible on the wire.
   */
  connected: boolean;
  /** Vessels currently tracked. A cold DO reports zero here beside zero counts. */
  vessels: number;
}

/**
 * Counts crossings inside the 24-hour window, per geofence.
 *
 * cleanupAggregates() already prunes each array to the same window, so the
 * filter here is normally a no-op. It stays because the count must be
 * window-correct even when the sweep last ran a minute ago, and because a
 * caller cannot tell how long ago that was.
 */
export function buildTransitsResponse(state: RelayState, now: number, connected: boolean): TransitsResponse {
  const transits: Record<string, TransitCounts> = {};

  for (const chokepoint of CHOKEPOINTS) {
    const crossings = state.chokepointCrossings.get(chokepoint.name) ?? [];
    const counts: TransitCounts = { tanker: 0, cargo: 0, other: 0, total: 0 };
    for (const crossing of crossings) {
      if (now - crossing.ts >= TRANSIT_WINDOW_MS) continue;
      counts[crossing.type] += 1;
      counts.total += 1;
    }
    transits[chokepoint.name] = counts;
  }

  return {
    transits,
    fetchedAt: now,
    windowHours: TRANSIT_WINDOW_MS / 3_600_000,
    connected,
    vessels: state.vessels.size,
  };
}
