import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRelayTransits } from '../scripts/seed-transit-summaries.mjs';

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
