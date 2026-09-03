import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSatelliteList, parseTleText, satClassify } from '../scripts/lib/satellite-tle.mjs';

// Verbatim from CelesTrak GROUP=military, served 2026-08-19. Element lines are
// exactly 69 characters; the name line is space-padded to 24.
const MILITARY = [
  'SAR-LUPE 2              ',
  '1 31797U 07030A   26230.91857109  .00025094  00000+0  33029-3 0  9999',
  '2 31797  98.1070 343.5903 0007920 191.6443 168.4629 15.58428450 66681',
  'SAPPHIRE                ',
  '1 39088U 13009C   26230.90498029  .00000066  00000+0  37855-4 0  9998',
  '2 39088  98.4301  48.8854 0012297  65.1297 295.1166 14.35254773705578',
  'SL-16 R/B               ',
  '1 23405U 94077B   26230.55555555  .00000100  00000+0  10000-3 0  9990',
  '2 23405  71.0000 100.0000 0010000 100.0000 260.0000 14.00000000100000',
].join('\n');

describe('parseTleText', () => {
  it('reads the name and both element lines of each 3-line set', () => {
    const sets = parseTleText(MILITARY);
    assert.equal(sets.length, 3);
    assert.deepEqual(sets[0], {
      noradId: '31797',
      name: 'SAR-LUPE 2',
      line1: '1 31797U 07030A   26230.91857109  .00025094  00000+0  33029-3 0  9999',
      line2: '2 31797  98.1070 343.5903 0007920 191.6443 168.4629 15.58428450 66681',
    });
  });

  it('tolerates CRLF, which CelesTrak serves', () => {
    assert.equal(parseTleText(MILITARY.replace(/\n/g, '\r\n')).length, 3);
  });

  // A wrapped or truncated response yields short element lines. Half a TLE is
  // worse than no TLE: it propagates a wrong orbit rather than an empty panel.
  it('skips a set whose element line is not 69 characters', () => {
    const truncated = MILITARY.split('\n');
    truncated[1] = truncated[1].slice(0, 60);
    assert.equal(parseTleText(truncated.join('\n')).length, 2);
  });

  it('returns empty on junk instead of throwing', () => {
    assert.deepEqual(parseTleText('<html>rate limited</html>'), []);
    assert.deepEqual(parseTleText(null), []);
  });
});

describe('buildSatelliteList', () => {
  it('drops names outside the tracked filters', () => {
    const names = buildSatelliteList([MILITARY]).map((s) => s.name);
    assert.deepEqual(names, ['SAR-LUPE 2', 'SAPPHIRE']);
    assert.ok(!names.includes('SL-16 R/B'));
  });

  it('keeps one entry per NORAD id when groups overlap', () => {
    const list = buildSatelliteList([MILITARY, MILITARY]);
    assert.equal(list.length, 2);
    assert.equal(new Set(list.map((s) => s.noradId)).size, 2);
  });

  it('carries type and country onto every entry', () => {
    for (const sat of buildSatelliteList([MILITARY])) {
      assert.ok(sat.type, `${sat.name} has no type`);
      assert.ok(sat.country, `${sat.name} has no country`);
    }
  });
});

describe('satClassify', () => {
  it('reads the SAR, optical and military families', () => {
    assert.deepEqual(satClassify('YAOGAN 33'), { type: 'sar', country: 'CN' });
    assert.deepEqual(satClassify('WORLDVIEW 3'), { type: 'optical', country: 'US' });
    assert.deepEqual(satClassify('COSMOS 2519'), { type: 'military', country: 'RU' });
    assert.deepEqual(satClassify('CARTOSAT 3'), { type: 'optical', country: 'IN' });
  });

  // An unrecognized country is OTHER, never silently folded into a real one.
  it('does not guess a country it cannot read', () => {
    assert.equal(satClassify('SENTINEL 1A').country, 'EU');
    assert.equal(satClassify('UNKNOWN BIRD').country, 'OTHER');
  });
});
