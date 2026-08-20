import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { validateNoHallucinatedProperNouns } from '../scripts/shared/brief-llm-core.js';

// Measured 2026-08-13 on a live `node scripts/seed-insights.mjs` run. The
// synthesis was correct and the validator rejected it:
//
//   ungrounded: patriot
//   said   "… Poland may send more Patriot systems to Kyiv [7]."
//   source "… It may send Kyiv more Patriots - Euromaidan Press"
//
// The source says Patriots, the model wrote Patriot attributively. Nothing was
// invented. Token-set membership is exact, so a summary that puts a plural noun
// in front of another noun — which is what English does — reads as a new name.
//
// The fold is deliberately narrow. Folding every trailing "s" would ground
// "Hamas" against a headline about "Hama", and turning a Syrian city into a
// militant group is exactly the invention this validator exists to catch.

describe('proper-noun grounding across singular and plural', () => {
  const POLAND_HEADLINE = 'Poland would rather the next Russian missile be downed over Ukraine than over its soil. It may send Kyiv more Patriots - Euromaidan Press';

  it('grounds a singular attributive against a plural source', () => {
    const result = validateNoHallucinatedProperNouns(
      'Poland may send more Patriot systems to Kyiv.',
      POLAND_HEADLINE,
    );

    assert.deepEqual(result, { ok: true });
  });

  it('grounds a plural summary against a singular source', () => {
    const result = validateNoHallucinatedProperNouns(
      'Ukraine now fields several Patriots.',
      'Ukraine receives another Patriot battery',
    );

    assert.deepEqual(result, { ok: true });
  });

  it('still rejects a weapon the source never named', () => {
    const result = validateNoHallucinatedProperNouns(
      'Poland may send more Javelin systems to Kyiv.',
      POLAND_HEADLINE,
    );

    assert.equal(result.ok, false);
  });

  // A vowel before the final s is the signature of a name, not a plural.
  it('does not turn Hama into Hamas', () => {
    const result = validateNoHallucinatedProperNouns(
      'Hamas rejected the proposal.',
      'Shelling reported in Hama overnight',
    );

    assert.equal(result.ok, false);
  });

  it('does not turn Texan into Texas', () => {
    const result = validateNoHallucinatedProperNouns(
      'Texas opened an inquiry.',
      'Texa County records another outage',
    );

    assert.equal(result.ok, false);
  });

  // Doubled s is not a plural either — "Ross" must not reach "Ros".
  it('does not fold a doubled s', () => {
    const result = validateNoHallucinatedProperNouns(
      'Ross filed the motion.',
      'Ros named in the filing',
    );

    assert.equal(result.ok, false);
  });

  // Short tokens are acronyms and country codes far more often than plurals.
  it('leaves short tokens alone', () => {
    const result = validateNoHallucinatedProperNouns(
      'AWS confirmed the outage.',
      'AW group confirmed the outage',
    );

    assert.equal(result.ok, false);
  });
});
