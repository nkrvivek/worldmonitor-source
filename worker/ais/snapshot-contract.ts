import type { RelayState, Bbox } from './vessel-state';
import {
  detectDisruptions,
  calculateDensityZones,
  getCandidateReportsSnapshot,
  getTankerReportsSnapshot,
} from './vessel-state';

/**
 * The wire shape of `GET /ais/snapshot`.
 *
 * A direct request/response pair, not an op-multiplexed protocol like
 * CounterDO's: AisRelayDO has exactly one caller-facing shape, so an op enum
 * would be speculative generality with no second use.
 *
 * `disruptions` and `density` are the two hard gates -- the consumer
 * (server/worldmonitor/maritime/v1/get-vessel-snapshot.ts) throws the whole
 * snapshot away unless both are arrays, degrading to a stale cache entry
 * rather than raising. Every other field it coerces with a default, so the
 * two arrays must be present even when empty.
 */
export interface SnapshotResponse {
  sequence: number;
  timestamp: number;
  status: {
    connected: boolean;
    vessels: number;
    messages: number;
    clients: number;
    droppedMessages: number;
  };
  disruptions: ReturnType<typeof detectDisruptions>;
  density: ReturnType<typeof calculateDensityZones>;
  candidateReports?: ReturnType<typeof getCandidateReportsSnapshot>;
  tankerReports?: ReturnType<typeof getTankerReportsSnapshot>;
}

/**
 * Matches the real /ais/snapshot HTTP handler in scripts/ais-relay.cjs, not
 * its buildSnapshot() alone: candidateReports and tankerReports attach here,
 * at the response-building layer and only when requested, never inside the
 * aggregation state.
 *
 * `clients` is always 0. This port carries no inbound WebSocket fanout -- that
 * server is dead and out of scope -- so there is never a connected browser
 * client to count. The field stays because the consumer reads a nested status
 * object and ops dashboards read this endpoint directly.
 */
export function buildSnapshotResponse(
  state: RelayState,
  sequence: number,
  includeCandidates: boolean,
  includeTankers: boolean,
  bbox: Bbox | null,
  connected: boolean = false,
): SnapshotResponse {
  const now = Date.now();
  return {
    sequence,
    timestamp: now,
    status: {
      connected,
      vessels: state.vessels.size,
      messages: state.messageCount,
      clients: 0,
      droppedMessages: state.droppedMessages,
    },
    disruptions: detectDisruptions(state, now),
    density: calculateDensityZones(state),
    ...(includeCandidates ? { candidateReports: getCandidateReportsSnapshot(state) } : {}),
    ...(includeTankers ? { tankerReports: getTankerReportsSnapshot(state, bbox) } : {}),
  };
}
