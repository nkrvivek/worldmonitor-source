import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGscpiPayload, parseGscpiCsv } from '../scripts/_gscpi.mjs';
import { extractGscpiObservations } from '../scripts/seed-economy.mjs';

// The NY Fed sheet carries a preamble row, one column per vintage, and #N/A for
// months a given vintage did not cover. Verbatim layout as served 2026-08-19.
const CSV = [
  'Global Supply Chain Pressure Index',
  ',,,',
  'Date,Jan-2026 vintage,Aug-2026 vintage',
  '31-Jan-2026,-0.51,-0.49',
  '28-Feb-2026,0.11,0.12',
  '31-Mar-2026,#N/A,0.34',
  '30-Apr-2026,#N/A,#N/A',
  '31-Jul-2026,#N/A,0.79',
].join('\n');

describe('parseGscpiCsv', () => {
  it('takes the last readable vintage on each row', () => {
    const obs = parseGscpiCsv(CSV);
    assert.deepEqual(obs, [
      { date: '2026-01-01', value: -0.49 },
      { date: '2026-02-01', value: 0.12 },
      { date: '2026-03-01', value: 0.34 },
      { date: '2026-07-01', value: 0.79 },
    ]);
  });

  it('drops a month where every vintage reads #N/A rather than calling it zero', () => {
    const obs = parseGscpiCsv(CSV);
    assert.ok(!obs.some((o) => o.date === '2026-04-01'));
  });

  it('returns oldest-first, the FRED convention the handler reads', () => {
    const obs = parseGscpiCsv(CSV);
    const dates = obs.map((o) => o.date);
    assert.deepEqual(dates, [...dates].sort());
  });

  it('returns empty on junk instead of throwing', () => {
    assert.deepEqual(parseGscpiCsv(''), []);
    assert.deepEqual(parseGscpiCsv('nothing,useful\nhere,either'), []);
  });
});

describe('buildGscpiPayload', () => {
  it('writes the shape the reader already extracts', () => {
    // seed-economy reads its own key back on a fetch failure. If these two ever
    // disagree the fallback silently serves nothing.
    const payload = buildGscpiPayload(parseGscpiCsv(CSV));
    const read = extractGscpiObservations(payload);
    assert.ok(read);
    assert.equal(read.observations.length, 4);
    assert.equal(payload.series.series_id, 'GSCPI');
  });
});
