import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { describeSeriesFaults, newestObservationMs } from '../scripts/seed-bls-series.mjs';

// Production 2026-08-12: the USPRIV fetch failed, the per-series catch warned,
// validate() passed on the one series that was left, and bls:series:v1
// published with recordCount 1. Nothing failed. The only symptom was
// STALE_CONTENT sixty days later, and only by luck — the survivor happened to
// be the quarterly series, whose newest observation is months old by design.
// Had the quarterly one dropped instead, the monthly survivor would have kept
// the aggregate budget green and the halved payload would still be shipping.

const NOW = Date.parse('2026-08-13T12:00:00.000Z');

const USPRIV = {
  seriesId: 'USPRIV',
  title: 'Total Private Nonfarm Payrolls',
  observations: [
    { year: '2026', period: 'M06', periodName: 'June', value: '135558' },
    { year: '2026', period: 'M07', periodName: 'July', value: '135588' },
  ],
};

const ECIALLCIV = {
  seriesId: 'ECIALLCIV',
  title: 'Employment Cost Index - All Civilian Workers',
  observations: [
    { year: '2026', period: 'M01', periodName: 'January', value: '175.618' },
    { year: '2026', period: 'M04', periodName: 'April', value: '177.178' },
  ],
};

describe('BLS series payload completeness', () => {
  it('accepts the whole payload', () => {
    assert.deepEqual(describeSeriesFaults({ series: [USPRIV, ECIALLCIV] }, NOW), []);
  });

  it('names a series that dropped out of the payload', () => {
    const faults = describeSeriesFaults({ series: [ECIALLCIV] }, NOW);

    assert.equal(faults.length, 1);
    assert.equal(faults[0].id, 'USPRIV');
    assert.match(faults[0].reason, /absent/);
  });

  // The half that the aggregate max can never see: the monthly series is
  // present and current, so newestItemAt clears the 75-day budget while the
  // quarterly series has silently stopped.
  it('names a frozen series the aggregate budget would mask', () => {
    const frozen = {
      ...ECIALLCIV,
      observations: [{ year: '2025', period: 'M04', periodName: 'April', value: '170.0' }],
    };
    const faults = describeSeriesFaults({ series: [USPRIV, frozen] }, NOW);

    assert.equal(faults.length, 1);
    assert.equal(faults[0].id, 'ECIALLCIV');
    assert.match(faults[0].reason, /budget 240d/);
  });

  // A quarterly release lands about four months after the quarter it is
  // stamped for, so the budget has to tolerate that gap or the seed would
  // refuse its own data every quarter.
  it('leaves a quarterly series alone through its normal publication gap', () => {
    const dayBeforeQ3Posts = Date.parse('2026-10-30T12:00:00.000Z');

    assert.deepEqual(describeSeriesFaults({ series: [USPRIV, ECIALLCIV] }, dayBeforeQ3Posts)
      .filter((f) => f.id === 'ECIALLCIV'), []);
  });

  it('treats a series with no dated observation as a fault, never as fresh', () => {
    const undated = { seriesId: 'USPRIV', observations: [{ value: '135588' }] };
    const faults = describeSeriesFaults({ series: [undated, ECIALLCIV] }, NOW);

    assert.equal(faults.length, 1);
    assert.equal(faults[0].id, 'USPRIV');
    assert.match(faults[0].reason, /no dated observation/);
  });

  it('reports an empty payload as every series missing', () => {
    assert.deepEqual(
      describeSeriesFaults({ series: [] }, NOW).map((f) => f.id).sort(),
      ['ECIALLCIV', 'USPRIV'],
    );
  });

  it('reads the newest observation, not the last one listed', () => {
    const outOfOrder = {
      seriesId: 'USPRIV',
      observations: [
        { year: '2026', period: 'M07', periodName: 'July', value: '135588' },
        { year: '2026', period: 'M06', periodName: 'June', value: '135558' },
      ],
    };

    assert.equal(newestObservationMs(outOfOrder, NOW), Date.UTC(2026, 6, 1));
  });
});
