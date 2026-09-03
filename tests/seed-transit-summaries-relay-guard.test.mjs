import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchRelayTransits,
  fetchRelayTransitsOrNull,
  buildSummaries,
  EXTRA_KEYS,
  TRANSITS_KEY,
  declareRecords,
  publishTransform,
} from '../scripts/seed-transit-summaries.mjs';
import { shouldSkipEmptyExtraKey } from '../scripts/_seed-utils.mjs';

// What the relay answers when the socket is open and the fences are live.
const LIVE = {
  transits: { 'Suez Canal': { tanker: 3, cargo: 5, other: 1, total: 9 } },
  fetchedAt: 0,
  windowHours: 24,
  connected: true,
  vessels: 8000,
};

const realFetch = globalThis.fetch;
const realRelayUrl = process.env.WS_RELAY_URL;

function answerWith(body, { ok = true, status = 200 } = {}) {
  globalThis.fetch = async () => ({
    ok,
    status,
    json: async () => body,
  });
}

describe('fetchRelayTransits', () => {
  before(() => {
    process.env.WS_RELAY_URL = 'https://relay.test';
  });

  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    if (realRelayUrl === undefined) delete process.env.WS_RELAY_URL;
    else process.env.WS_RELAY_URL = realRelayUrl;
  });

  it('returns the transits when the feed is live', async () => {
    answerWith(LIVE);
    const transits = await fetchRelayTransits();
    assert.equal(transits['Suez Canal'].total, 9);
  });

  it('refuses when the socket is disconnected', async () => {
    answerWith({ ...LIVE, connected: false, vessels: 0 });
    await assert.rejects(fetchRelayTransits(), /not delivering/);
  });

  // The live failure this guard was written for. On 2026-08-06 the relay
  // answered connected:true with vessels:0 -- an open socket that AISStream had
  // sent nothing over -- and every fence read total:0. The seed published those
  // zeros over the last good counts and wiped every todayTotal on the panel.
  it('refuses when the socket is open but no vessel has been seen', async () => {
    answerWith({
      transits: { 'Suez Canal': { tanker: 0, cargo: 0, other: 0, total: 0 } },
      fetchedAt: 0,
      windowHours: 24,
      connected: true,
      vessels: 0,
    });
    await assert.rejects(fetchRelayTransits(), /not delivering/);
  });

  // A response with no `vessels` field cannot say whether the feed is alive.
  // Refusing keeps the last good counts; publishing would bet the panel on a
  // field that is not there.
  it('refuses when the response omits the vessel count', async () => {
    const { vessels, ...withoutVessels } = LIVE;
    answerWith(withoutVessels);
    await assert.rejects(fetchRelayTransits(), /not delivering/);
  });

  it('refuses on a non-ok response', async () => {
    answerWith({}, { ok: false, status: 522 });
    await assert.rejects(fetchRelayTransits(), /HTTP 522/);
  });

  it('refuses when the payload carries no transits object', async () => {
    answerWith({ connected: true, vessels: 8000 });
    await assert.rejects(fetchRelayTransits(), /no transits object/);
  });
});

// The relay is one of three inputs. Until 2026-08-07 its refusal aborted the
// whole seed, so an AIS outage that had run since 2026-08-05 also stopped the
// five risk fields — which arrive over plain HTTP from corridorrisk.io and
// never touch AIS. The key went unwritten for 2h19m against a 10-minute cron.
describe('a dead relay costs the relay fields and nothing else', () => {
  const PORTWATCH = {
    hormuz_strait: { wowChangePct: 58.8, history: [] },
    suez: { wowChangePct: -2.1, history: [] },
  };
  const CORRIDOR_RISK = {
    hormuz_strait: {
      riskLevel: 'critical', incidentCount7d: 134, disruptionPct: 100,
      riskSummary: 'Sustained armed conflict', riskReportAction: 'Avoid transit',
    },
  };

  before(() => {
    process.env.WS_RELAY_URL = 'https://relay.test';
  });

  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    if (realRelayUrl === undefined) delete process.env.WS_RELAY_URL;
    else process.env.WS_RELAY_URL = realRelayUrl;
  });

  it('returns null instead of throwing when the feed is not delivering', async () => {
    answerWith({ ...LIVE, connected: true, vessels: 0 });
    assert.equal(await fetchRelayTransitsOrNull(), null);
  });

  it('still returns the transits when the feed is live', async () => {
    answerWith(LIVE);
    const transits = await fetchRelayTransitsOrNull();
    assert.equal(transits['Suez Canal'].total, 9);
  });

  it('publishes the risk fields when the relay gave nothing', () => {
    const { summaries } = buildSummaries(PORTWATCH, CORRIDOR_RISK, null, 0);
    const hormuz = summaries.hormuz_strait;
    assert.equal(hormuz.riskLevel, 'critical');
    assert.equal(hormuz.incidentCount7d, 134);
    assert.equal(hormuz.disruptionPct, 100);
  });

  it('reads the counts as zero rather than inventing them', () => {
    const { summaries } = buildSummaries(PORTWATCH, CORRIDOR_RISK, null, 0);
    const hormuz = summaries.hormuz_strait;
    assert.equal(hormuz.todayTotal, 0);
    assert.equal(hormuz.todayTanker, 0);
    assert.equal(hormuz.todayCargo, 0);
    assert.equal(hormuz.todayOther, 0);
  });

  // dataAvailable gates the history chart and feeds coveredCount in
  // get-chokepoint-status.ts, both of which ask about PortWatch. A relay
  // outage that flipped it would report a full house of chokepoints as
  // uncovered, flip upstreamUnavailable on the response, and drive
  // declareRecords to zero — which makes runSeed publish nothing at all.
  it('leaves dataAvailable on PortWatch, so the run still has records', () => {
    const built = buildSummaries(PORTWATCH, CORRIDOR_RISK, null, 0);
    assert.equal(built.summaries.hormuz_strait.dataAvailable, true);
    assert.equal(built.summaries.panama.dataAvailable, false);
    assert.equal(declareRecords(publishTransform(built)), 2);
  });

  // dataAvailable answers for PortWatch and nothing else, so before this field
  // existed a dead relay published thirteen zero counts with no mark on them.
  // Read from outside, a zero count and a chokepoint nobody sailed through were
  // the same row — and Hormuz carried PortWatch's real +58.8 next to its zero on
  // 2026-08-07, which reads as traffic rose while no ship moved.
  it('marks the counts as absent when the relay gave nothing', () => {
    const { summaries } = buildSummaries(PORTWATCH, CORRIDOR_RISK, null, 0);
    assert.equal(summaries.hormuz_strait.transitCountsAvailable, false);
    assert.equal(summaries.panama.transitCountsAvailable, false);
  });

  it('marks the counts as present when the relay answered', () => {
    const { summaries } = buildSummaries(PORTWATCH, CORRIDOR_RISK, LIVE.transits, 0);
    assert.equal(summaries.suez.transitCountsAvailable, true);
  });

  // A live relay that saw nothing cross a quiet strait is a real zero. It must
  // not be marked absent, or the field would say "no feed" every quiet hour.
  it('keeps a real zero from a live relay marked present', () => {
    const { summaries } = buildSummaries(PORTWATCH, CORRIDOR_RISK, LIVE.transits, 0);
    assert.equal(summaries.panama.todayTotal, 0);
    assert.equal(summaries.panama.transitCountsAvailable, true);
  });

  // Nothing else writes the raw counts by geofence name, so an empty write
  // erases the last good counts with no way back.
  it('skips the raw-counts write instead of zeroing it', () => {
    const built = buildSummaries(PORTWATCH, CORRIDOR_RISK, null, 0);
    const entry = EXTRA_KEYS.find((ek) => ek.key === TRANSITS_KEY);
    const payload = entry.transform(built);
    assert.deepEqual(payload.transits, {});
    assert.equal(shouldSkipEmptyExtraKey(entry, entry.declareRecords(payload)), true);
  });

  it('writes the raw counts when the relay answered', () => {
    const built = buildSummaries(PORTWATCH, CORRIDOR_RISK, LIVE.transits, 0);
    const entry = EXTRA_KEYS.find((ek) => ek.key === TRANSITS_KEY);
    const payload = entry.transform(built);
    assert.equal(shouldSkipEmptyExtraKey(entry, entry.declareRecords(payload)), false);
    assert.equal(built.summaries.suez.todayTotal, 9);
  });
});
