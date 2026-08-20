import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  extractProperNounSequences,
  validateNoHallucinatedProperNouns,
} from '../scripts/shared/brief-llm-core.js';

// Production 2026-08-13, on the first healthy corpus after the digest fix
// (284 items, 9 brief-eligible clusters): every provider was rejected by the
// lead proper-noun gate and the brief fell back for the eighth run running.
//
//   lead   "Attacks on Ukraine's grain hubs raise fears over global food prices [1] …"
//   ground "Russia-Ukraine war: Grain hub attacks raise fears over global food prices"
//   verdict ungrounded: attacks
//
// The word is right there in the source. The extractor only collects
// CAPITALIZED tokens, so a word the source uses lowercase never enters the
// ground set, while the same word starting a sentence in the summary is
// capitalized by grammar and reads as an invented name. The old defence was
// SENTENCE_START_AMBIGUOUS, a hand-kept list of common words — and English has
// no finite list of nouns that may start a sentence, so the gate rejected any
// lead whose opening word nobody had thought to add. Both providers hit it the
// same morning on different words ("Attacks", "War").

const GROUND = 'Russia-Ukraine war: Grain hub attacks raise fears over global food prices';

describe('a capitalized sentence-start word the source uses lowercase', () => {
  it('accepts the lead that production rejected', () => {
    const lead = "Attacks on Ukraine's grain hubs raise fears over global food prices";

    assert.equal(validateNoHallucinatedProperNouns(lead, GROUND).ok, true);
  });

  it('accepts a one-word opener the source carries lowercase', () => {
    assert.equal(validateNoHallucinatedProperNouns('War raises fears over food prices', GROUND).ok, true);
  });

  it('keeps flagging a name the source never mentions', () => {
    const invented = 'Zelensky ordered grain hubs evacuated';
    const result = validateNoHallucinatedProperNouns(invented, GROUND);

    assert.equal(result.ok, false);
    assert.deepEqual(result.hallucinated, ['zelensky']);
  });

  // The evidence is the source's own lowercase usage, so it must not license
  // the word anywhere else in the summary — only where grammar forced the
  // capital. Mid-sentence, a capital is the writer's choice and still a claim.
  it('does not license the same word mid-sentence', () => {
    const midSentence = 'Ukraine said Attacks continued overnight';

    assert.equal(validateNoHallucinatedProperNouns(midSentence, GROUND).ok, false);
  });

  it('still grounds a real name that opens a sentence', () => {
    const ground = 'Ukraine reports record casualties';

    assert.equal(validateNoHallucinatedProperNouns('Ukraine reports record casualties', ground).ok, true);
  });

  // An acronym is never common-word capitalization, whatever the source does
  // with the letters elsewhere.
  it('treats a sentence-initial acronym as a proper noun regardless', () => {
    const result = validateNoHallucinatedProperNouns('NATO condemned the strikes', 'nato talks on grain corridors');

    assert.equal(result.ok, false);
  });

  it('drops only the opener, leaving the rest of the sequence intact', () => {
    const evidence = new Set(['attacks']);
    const sequences = extractProperNounSequences('Attacks on Ukraine grain hubs', {
      commonWordEvidence: evidence,
    });

    assert.deepEqual(sequences, [['ukraine']]);
  });

  it('reads the same without evidence, so existing callers are unchanged', () => {
    assert.deepEqual(
      extractProperNounSequences('Attacks on Ukraine grain hubs'),
      [['attacks'], ['ukraine']],
    );
  });
});

// The two copies are byte-identical and both tracked. Nothing tied them
// together, so a fix applied to one would leave the seeders and the edge
// functions disagreeing about what counts as invented.
describe('brief-llm-core mirrors', () => {
  it('keeps scripts/shared and shared byte-identical', () => {
    const scriptsCopy = readFileSync(new URL('../scripts/shared/brief-llm-core.js', import.meta.url), 'utf8');
    const sharedCopy = readFileSync(new URL('../shared/brief-llm-core.js', import.meta.url), 'utf8');

    assert.equal(scriptsCopy, sharedCopy, 'shared/brief-llm-core.js drifted from scripts/shared/brief-llm-core.js');
  });
});
