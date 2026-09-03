import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildGdacsUrl, fetchNaturalEvents } from '../scripts/seed-natural-events.mjs';

// GDACS answers a bare /geteventlist/MAP with 400 {"message":"Eventtype is
// required."}. Every other leg of this seed is optional to the merge, so the
// rejection cost nothing visible here and instead starved
// seed-climate-disasters, which keeps only the GDACS storms out of this key.
// These tests pin the two things that made it survive a day: the request has to
// name the event types, and a refusal has to say what the upstream said.

// One live event from another source, so the merge writes a payload and the
// sources block can be read. A seed that stores nothing at all returns null,
// which would hide the very field under test.
const EONET_ONE_EVENT = {
  events: [{
    id: 'EONET_1',
    title: 'Klyuchevskoy Volcano',
    categories: [{ id: 'volcanoes', title: 'Volcanoes' }],
    geometry: [{ type: 'Point', date: '2026-08-12T00:00:00Z', coordinates: [160.64, 56.06] }],
    sources: [{ id: 'SIVolcano', url: 'https://volcano.si.edu/' }],
    closed: null,
  }],
};

const OTHER_SOURCES = async (url, eonet = { events: [] }) => {
  const target = String(url);
  if (target.includes('eonet.gsfc.nasa.gov')) return new Response(JSON.stringify(eonet));
  if (target.includes('data.weather.gov.hk')) return new Response(JSON.stringify({}));
  if (target.includes('mapservices.weather.noaa.gov')) {
    return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }));
  }
  throw new Error(`unexpected source ${target}`);
};

describe('GDACS request', () => {
  it('asks for every event type the parser can map', () => {
    const url = new URL(buildGdacsUrl(Date.parse('2026-08-13T12:00:00.000Z')));
    const requested = (url.searchParams.get('eventlist') || '').split(',').filter(Boolean);

    assert.deepEqual(requested.slice().sort(), ['DR', 'EQ', 'FL', 'TC', 'VO', 'WF']);
    assert.equal(url.pathname.endsWith('/geteventlist/SEARCH'), true);
  });

  // The response is capped at 100 features, so an unbounded call silently drops
  // whatever sorts past the hundredth row. Asking for a window keeps the answer
  // complete rather than merely large.
  it('bounds the search to the same 30 days EONET is asked for', () => {
    const url = new URL(buildGdacsUrl(Date.parse('2026-08-13T12:00:00.000Z')));

    assert.equal(url.searchParams.get('fromdate'), '2026-07-14');
    assert.equal(url.searchParams.get('todate'), '2026-08-13');
  });

  it('sends the event list upstream rather than a bare list call', async () => {
    let gdacsUrl = '';

    await fetchNaturalEvents({
      now: Date.parse('2026-08-13T12:00:00.000Z'),
      fetchFn: async (url) => {
        const target = String(url);
        if (!target.includes('gdacs.org')) return OTHER_SOURCES(url);
        gdacsUrl = target;
        return new Response(JSON.stringify({ features: [] }));
      },
    });

    assert.ok(gdacsUrl, 'GDACS was never called');
    assert.ok(
      new URL(gdacsUrl).searchParams.get('eventlist'),
      `GDACS was called without an event list: ${gdacsUrl}`,
    );
  });

  it('records what GDACS said when it refuses, not only the status code', async () => {
    const payload = await fetchNaturalEvents({
      now: Date.parse('2026-08-13T12:00:00.000Z'),
      fetchFn: async (url) => {
        if (!String(url).includes('gdacs.org')) return OTHER_SOURCES(url, EONET_ONE_EVENT);
        return new Response(JSON.stringify({ message: 'Eventtype is required.' }), { status: 400 });
      },
    });

    const gdacs = payload.sources.GDACS;
    assert.equal(gdacs.status, 'rejected');
    assert.match(gdacs.reason, /400/);
    assert.match(gdacs.reason, /Eventtype is required/);
  });
});
