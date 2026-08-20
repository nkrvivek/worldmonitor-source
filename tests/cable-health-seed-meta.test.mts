import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cableHealthSeedMeta } from '../server/worldmonitor/infrastructure/v1/get-cable-health';

// getCableHealth serves stale data when NGA is unreachable, which is right: a
// cable health map computed 40 minutes ago is worth far more than an empty one.
// What was wrong is what it told the freshness rail about that data. Both the
// NGA-failed path and the outer catch stamped seed-meta with Date.now(), so
// api/health.js read the moment we last SERVED the map rather than the moment
// anyone last COMPUTED it. NGA could be down for a week and cable-health would
// report fresh the whole time, because every 30-minute warm-ping re-stamped the
// same stale response. There is no window in which that reports a problem.
//
// The rule these tests pin: seed-meta carries the age of the DATA. The
// fallback path stops re-stamping, so freshness ages honestly and health.js
// raises it once it passes the 90-minute window — while the canonical key stays
// populated, which is what the writeback was added for in the first place.
describe('cableHealthSeedMeta', () => {
  it('dates a reading from when it was computed, not from when it was served', () => {
    const computedAt = 1_770_000_000_000;
    const servedAt = computedAt + 6 * 60 * 60 * 1000;

    const meta = cableHealthSeedMeta(
      { generatedAt: computedAt, cables: { 'sea-me-we-4': {}, 'aae-1': {} } } as never,
      servedAt,
    );

    assert.deepEqual(meta, { fetchedAt: computedAt, recordCount: 2 });
  });

  it('writes nothing when we have never had a reading', () => {
    // The old code substituted { generatedAt: Date.now(), cables: {} } here and
    // wrote seed-meta from it, which claims a fresh measurement of zero cables.
    // A cold isolate whose first NGA call failed reported healthy-and-empty.
    assert.equal(cableHealthSeedMeta(null, 1_770_000_000_000), null);
  });

  it('reports a genuine empty reading rather than suppressing it', () => {
    // Zero cables from a response we actually computed is a measurement, and a
    // different one from having no response at all. Only the second is absent.
    const computedAt = 1_770_000_000_000;

    assert.deepEqual(
      cableHealthSeedMeta({ generatedAt: computedAt, cables: {} } as never, computedAt),
      { fetchedAt: computedAt, recordCount: 0 },
    );
  });

  it('falls back to the serve time only when the response carries no date', () => {
    // An undated response is the one case where we cannot say when it was
    // computed. Treating it as epoch would report a decade of staleness on
    // what may be a fresh map, so it is stamped now and the ambiguity is
    // recorded here rather than guessed at differently by each caller.
    const servedAt = 1_770_000_000_000;

    assert.deepEqual(
      cableHealthSeedMeta({ cables: { 'aae-1': {} } } as never, servedAt),
      { fetchedAt: servedAt, recordCount: 1 },
    );
  });

  it('treats a missing cable map as no records rather than throwing', () => {
    const servedAt = 1_770_000_000_000;

    assert.deepEqual(
      cableHealthSeedMeta({ generatedAt: servedAt } as never, servedAt),
      { fetchedAt: servedAt, recordCount: 0 },
    );
  });
});
