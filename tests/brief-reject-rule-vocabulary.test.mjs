import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRIEF_REJECT_RULES, BRIEF_REJECT_RULE_SET } from '../api/_insights-reject-rules.js';
import { BRIEF_REJECT_RULES as AUTHORED_RULES } from '../scripts/_insights-brief.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(resolve(root, rel), 'utf-8');

/** Every rule name the gate actually raises, read off the source. */
function rejectLiterals() {
  const src = readSrc('scripts/_insights-brief.mjs');
  const found = new Set();
  for (const m of src.matchAll(/\breject\(\s*'([a-z0-9-]+)'/g)) found.add(m[1]);
  return found;
}

test('every rule the gate raises is in the published vocabulary', () => {
  const raised = rejectLiterals();
  assert.ok(raised.size > 0, 'no reject() literals found — the scanner regex has drifted');
  const missing = [...raised].filter((rule) => !BRIEF_REJECT_RULE_SET.has(rule));
  assert.deepEqual(
    missing,
    [],
    `these rules fire but are not in BRIEF_REJECT_RULES, so seed-meta and health would drop them: ${missing.join(', ')}`,
  );
});

test('the vocabulary carries no rule the gate cannot raise', () => {
  const raised = rejectLiterals();
  const dead = BRIEF_REJECT_RULES.filter((rule) => !raised.has(rule));
  assert.deepEqual(dead, [], `listed but never raised: ${dead.join(', ')}`);
});

test('the vocabulary is frozen and has no duplicates', () => {
  assert.ok(Object.isFrozen(BRIEF_REJECT_RULES));
  assert.equal(BRIEF_REJECT_RULE_SET.size, BRIEF_REJECT_RULES.length);
});

test('health reads the same list it is documented against', () => {
  // health.js gates the public field on this Set. A local mirror here would be
  // the drift this file exists to catch, so assert the import instead.
  const src = readSrc('api/health.js');
  assert.match(src, /import \{ BRIEF_REJECT_RULE_SET \} from '\.\/_insights-reject-rules\.js';/);
  assert.match(src, /BRIEF_REJECT_RULE_SET\.has\(meta\.lastSynthesisRejectRule\)/);
});

// The seeder cannot import api/ (Railway ships only scripts/ to the container)
// and health cannot import the seeder, so the list exists twice. This is the
// test that makes the duplication safe: a rule added on one side and forgotten
// on the other would otherwise be recorded by the seeder and dropped by health,
// which reads as "no rule fired" — the exact silence this seam removed.
test('the api mirror and the authored list are identical, in order', () => {
  assert.deepEqual(
    [...BRIEF_REJECT_RULES],
    [...AUTHORED_RULES],
    'api/_insights-reject-rules.js has drifted from BRIEF_REJECT_RULES in scripts/_insights-brief.mjs',
  );
});
