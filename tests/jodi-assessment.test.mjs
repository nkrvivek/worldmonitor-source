import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReportedAssessment,
  assessmentLabel,
  summarizeAssessment,
} from '../scripts/shared/jodi-assessment.mjs';

describe('isReportedAssessment', () => {
  it('reads the three levels JODI publishes', () => {
    for (const code of ['1', '2', '3', 1, 2, 3, ' 3 ']) {
      assert.equal(isReportedAssessment(code), true, `${code} is documented`);
    }
  });

  it('refuses anything JODI does not document', () => {
    for (const code of [null, undefined, '', '  ', '0', '4', 'purple', {}]) {
      assert.equal(isReportedAssessment(code), false, `${String(code)} is not a level we can read`);
    }
  });
});

describe('assessmentLabel', () => {
  it('names each level in JODI\'s own words', () => {
    assert.equal(assessmentLabel('1'), 'comparable');
    assert.equal(assessmentLabel('2'), 'consult-metadata');
    assert.equal(assessmentLabel('3'), 'unassessed');
  });

  it('returns null rather than guessing at an unknown code', () => {
    assert.equal(assessmentLabel('4'), null);
    assert.equal(assessmentLabel(undefined), null);
  });
});

describe('summarizeAssessment', () => {
  it('reports the least-confident level present', () => {
    assert.deepEqual(summarizeAssessment(['1', '2']), { code: '2', label: 'consult-metadata' });
    assert.deepEqual(summarizeAssessment(['1', '3', '2']), { code: '3', label: 'unassessed' });
    assert.deepEqual(summarizeAssessment(['1', '1']), { code: '1', label: 'comparable' });
  });

  it('ignores codes it cannot read instead of treating them as a level', () => {
    assert.deepEqual(summarizeAssessment(['1', '9', '']), { code: '1', label: 'comparable' });
  });

  it('returns null when nothing readable was supplied', () => {
    // An absent level is not a good one, so the record says nothing rather than
    // claiming the data was checked.
    assert.equal(summarizeAssessment([]), null);
    assert.equal(summarizeAssessment(['', null, '7']), null);
    assert.equal(summarizeAssessment(undefined), null);
  });
});
