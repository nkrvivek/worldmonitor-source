import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { NGA_BROADCAST_WARN_URL, parseNgaBroadcastWarnings } from '../server/_shared/nga';

// Measured against the live endpoint on 2026-08-13: 200, 206,479 bytes, one
// top-level key, 386 rows under it.
//
//   $ curl -s 'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A'
//   {"broadcast-warn": [ ... 386 rows ... ]}
//
// get-cable-health read `data.warnings` and list-navigational-warnings read
// `data.broadcast_warn`. Both got undefined, both had `?? []` behind them, and
// neither threw. A wrong key name is invisible to a try/catch.
describe('parseNgaBroadcastWarnings', () => {
  it('reads the hyphenated key NGA actually ships', () => {
    const rows = parseNgaBroadcastWarnings({
      'broadcast-warn': [{ navArea: 'IV', msgNumber: 123, msgYear: 2026 }],
    });

    assert.equal(rows?.length, 1);
  });

  it('accepts a bare array, which is what the old code was tolerant of', () => {
    assert.deepEqual(parseNgaBroadcastWarnings([{ navArea: 'IV' }]), [{ navArea: 'IV' }]);
  });

  it('reports an unrecognized shape as a failure, never as calm seas', () => {
    // The exact fault. Every one of these used to become `[]`, and `[]` is not
    // an error, so it cached under the 24h NGA TTL and served an empty cable
    // map until the next day.
    assert.equal(parseNgaBroadcastWarnings({ warnings: [{ navArea: 'IV' }] }), null);
    assert.equal(parseNgaBroadcastWarnings({ broadcast_warn: [{ navArea: 'IV' }] }), null);
    assert.equal(parseNgaBroadcastWarnings({}), null);
    assert.equal(parseNgaBroadcastWarnings(null), null);
    assert.equal(parseNgaBroadcastWarnings('broadcast-warn'), null);
    assert.equal(parseNgaBroadcastWarnings({ 'broadcast-warn': 'nope' }), null);
  });

  it('passes an empty list through, because NGA is allowed to say nothing is active', () => {
    // The distinction the whole module exists for. A recognized payload with
    // no rows has measured a quiet day; an unrecognized one has measured
    // nothing at all. Collapsing them is what cost a day of cable health.
    assert.deepEqual(parseNgaBroadcastWarnings({ 'broadcast-warn': [] }), []);
  });
});

// Both handlers must go through the shared parser. Two readers of one endpoint
// drifted to two different wrong key names precisely because each held its own
// copy of the parse.
describe('the NGA readers', () => {
  const readers = [
    'server/worldmonitor/infrastructure/v1/get-cable-health.ts',
    'server/worldmonitor/maritime/v1/list-navigational-warnings.ts',
  ];

  // The rule is about what the handler executes. Both files name the old wrong
  // keys in comments on purpose, so that the next person reading them learns
  // what went wrong rather than rediscovering it.
  const codeOf = (reader: string) =>
    readFileSync(new URL(`../${reader}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  for (const reader of readers) {
    it(`${reader} parses through the shared module`, () => {
      const source = codeOf(reader);

      // assert.ok rather than assert.match: a failed match prints the whole
      // 700-line handler, which buries the one sentence that says what broke.
      assert.ok(source.includes('parseNgaBroadcastWarnings'), `${reader} does not use the shared parser`);
      assert.ok(
        !/broadcast_warn|\.warnings\s*\?\?/.test(source),
        `${reader} still holds a private copy of the parse, which is how the two readers drifted apart`,
      );
    });
  }

  it('every reader fetches the one URL the parser documents', () => {
    for (const reader of readers) {
      const source = codeOf(reader);
      assert.ok(source.includes('NGA_BROADCAST_WARN_URL'), `${reader} does not use the shared URL`);
      assert.ok(!/msi\.nga\.mil/.test(source), `${reader} hardcodes the URL; it belongs to the shared module`);
    }

    assert.equal(
      NGA_BROADCAST_WARN_URL,
      'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A',
    );
  });
});
