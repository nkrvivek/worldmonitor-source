import { describe, it, expect } from 'vitest';
import { createRelayState } from '../../worker/ais/vessel-state';
import { buildSnapshotResponse } from '../../worker/ais/snapshot-contract';

// The shape asserted here is what
// server/worldmonitor/maritime/v1/get-vessel-snapshot.ts reads back off the
// wire. Two of its checks are hard gates rather than field-level fallbacks:
// it returns undefined for the WHOLE snapshot unless both `disruptions` and
// `density` are arrays, and it reads `candidateReports`/`tankerReports` only
// when the matching include flag was sent. Everything else it coerces with a
// default, so only those gates need contract tests.

describe('buildSnapshotResponse', () => {
  it('always includes disruptions and density as arrays, even when empty', () => {
    const state = createRelayState();
    const response = buildSnapshotResponse(state, 1, false, false, null);
    expect(Array.isArray(response.disruptions)).toBe(true);
    expect(Array.isArray(response.density)).toBe(true);
  });

  it('omits candidateReports and tankerReports when not requested', () => {
    const state = createRelayState();
    const response = buildSnapshotResponse(state, 1, false, false, null);
    expect(response.candidateReports).toBeUndefined();
    expect(response.tankerReports).toBeUndefined();
  });

  it('includes candidateReports and tankerReports as arrays when requested, even when empty', () => {
    const state = createRelayState();
    const response = buildSnapshotResponse(state, 1, true, true, null);
    expect(Array.isArray(response.candidateReports)).toBe(true);
    expect(Array.isArray(response.tankerReports)).toBe(true);
  });

  it('carries the sequence number and a status object with the connected flag', () => {
    const state = createRelayState();
    const response = buildSnapshotResponse(state, 42, false, false, null);
    expect(response.sequence).toBe(42);
    expect(response.status).toMatchObject({ vessels: 0, messages: 0, droppedMessages: 0 });
  });

  it('reports connected false by default and true when the caller says so', () => {
    const state = createRelayState();
    expect(buildSnapshotResponse(state, 1, false, false, null).status.connected).toBe(false);
    expect(buildSnapshotResponse(state, 1, false, false, null, true).status.connected).toBe(true);
  });

  it('reports live vessel, message and drop counts off the state', () => {
    const state = createRelayState();
    state.vessels.set('123456789', {
      mmsi: '123456789',
      name: 'TEST',
      lat: 1,
      lon: 1,
      timestamp: Date.now(),
    });
    state.messageCount = 7;
    state.droppedMessages = 3;
    const response = buildSnapshotResponse(state, 1, false, false, null);
    expect(response.status).toMatchObject({ vessels: 1, messages: 7, droppedMessages: 3, clients: 0 });
  });

  it('passes the bbox through to the tanker snapshot', () => {
    const state = createRelayState();
    const now = Date.now();
    state.tankerReports.set('111111111', {
      mmsi: '111111111',
      name: 'IN BOX',
      lat: 5,
      lon: 5,
      timestamp: now,
    });
    state.tankerReports.set('222222222', {
      mmsi: '222222222',
      name: 'OUT OF BOX',
      lat: 50,
      lon: 50,
      timestamp: now,
    });
    const response = buildSnapshotResponse(state, 1, false, true, {
      swLat: 0,
      swLon: 0,
      neLat: 10,
      neLon: 10,
    });
    expect(response.tankerReports?.map((r) => r.mmsi)).toEqual(['111111111']);
  });
});
