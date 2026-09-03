/**
 * JODI's own assessment colour codes, as published on
 * https://www.jodidata.org/oil/support/user-guide/assessments.aspx
 *
 *   1 blue   "results of the assessment show reasonable levels of comparability"
 *   2 yellow "the metadata should be consulted"
 *   3 white  "data has not been assessed"
 *
 * White means UNASSESSED, not wrong. Both seeders used to keep 1 and 2 and drop
 * 3, which silently threw away 67 of the 118 countries that report to JODI,
 * China among them, and so left the China coverage gate unsatisfiable. An
 * unassessed measurement is still a measurement; what it is not is a checked
 * one, so the level travels with the record instead of being discarded.
 *
 * Anything outside 1-3 (blank, "4", a future purple "under verification" code)
 * is not a level we can read, so it is excluded rather than assumed.
 */
const LABELS = Object.freeze({
  1: 'comparable',
  2: 'consult-metadata',
  3: 'unassessed',
});

/** True only for a code JODI documents. Absent or unknown is never permissive. */
export function isReportedAssessment(code) {
  if (code === null || code === undefined) return false;
  const text = String(code).trim();
  if (text === '') return false;
  return Object.hasOwn(LABELS, text);
}

export function assessmentLabel(code) {
  return isReportedAssessment(code) ? LABELS[String(code).trim()] : null;
}

/**
 * The least-confident level present among the codes that carried a value.
 *
 * Ordering is 1 (checked) then 2 (check the metadata) then 3 (never checked),
 * so the maximum is the weakest claim the record can make. Returns null when
 * nothing readable was supplied, because an absent level is not a good one.
 */
export function summarizeAssessment(codes) {
  const readable = (Array.isArray(codes) ? codes : [])
    .filter(isReportedAssessment)
    .map(code => Number(String(code).trim()));
  if (readable.length === 0) return null;
  const worst = String(Math.max(...readable));
  return { code: worst, label: LABELS[worst] };
}
