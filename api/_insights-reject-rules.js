/**
 * Edge-safe mirror of BRIEF_REJECT_RULES in scripts/_insights-brief.mjs.
 *
 * The list is authored beside the reject() calls that raise it. health needs
 * the same names to republish the deciding rule, but cannot import that file:
 * the seeder ships to Railway with only scripts/ in the container, so the
 * dependency can only run one way, and it runs the other way. Hence a mirror,
 * held identical by tests/brief-reject-rule-vocabulary.
 *
 * Fixed vocabulary is the safety property. seed-meta, health responses and
 * logs carry rule names but never prompt or model output: the digest payload
 * can hold sensitive intelligence. Anything outside this list is dropped on
 * both sides rather than defaulted, because a wrong rule name sends the reader
 * at a test that did not fire.
 */
export const BRIEF_REJECT_RULES = Object.freeze([
  'no-top-stories',
  'no-brief-cluster',
  'unparseable-synthesis',
  'empty-lead',
  'uncited-lead-sentence',
  'lead-proper-noun',
  'lead-fact',
  'lead-anchor-grounding',
]);

export const BRIEF_REJECT_RULE_SET = new Set(BRIEF_REJECT_RULES);
