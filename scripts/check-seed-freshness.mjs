#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Our own host. It used to name api.worldmonitor.app, which is upstream's --
// so a run here graded upstream's seeds and reported the verdict as ours, which
// is worse than no answer. worker/routes/health.ts routes the bare path;
// /api/health/v1/ is a different service and belongs to worker/routes/domains.ts.
// HEALTH_URL overrides it.
const DEFAULT_HEALTH_URL = 'https://worldmonitor.sibt.ai/api/health?compact=1';
const BASELINE_URL = new URL('./seed-freshness-baseline.json', import.meta.url);

export function validateCompactHealthPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Compact health payload must be an object');
  }
  // Compact health omits `problems` entirely when every check is healthy.
  if (payload.problems == null && payload.status === 'HEALTHY') return payload;
  if (!payload.problems || typeof payload.problems !== 'object' || Array.isArray(payload.problems)) {
    throw new Error('Compact health payload must contain a problems object');
  }
  return payload;
}

// The ONLY states being on-demand actually explains: nothing has requested the
// key yet, or the producer has not run for the first time. Absence is expected
// for an RPC-populated cache or a deployment-order bridge, so it must not page.
//
// Everything else must stay strict even for an on-demand source. `SEED_ERROR`
// means the producer ran and failed; a long `STALE_SEED` means it stopped
// running. Neither is explained by "nobody asked for it yet", and softening
// them is a known-bad trade: api/health.js's ON_DEMAND_KEYS policy block
// records `marketImplications` sitting at 8.2x its staleness budget for 16+
// hours undetected for exactly this reason, which is why that key was removed
// from the set. Do not widen this list to cover fault statuses — a genuinely
// accepted degradation belongs in seed-freshness-baseline.json, where it
// carries an owner issue and an expiry.
const ON_DEMAND_SOFT_STATUSES = new Set(['EMPTY_ON_DEMAND', 'EMPTY', 'EMPTY_DATA']);

// `/api/health` marks on-demand sources with `onDemand: true` on every status
// (api/health.js classifyKey). The status-suffix test is retained as a fallback
// for compact snapshots cached before that marker shipped, and is self-limiting:
// `EMPTY_ON_DEMAND` is the only `_ON_DEMAND` status, so it covers only the
// absent/zero-record branches — the same set the marker path allows.
export function isOnDemandProblem(problem) {
  if (typeof problem?.status === 'string' && problem.status.endsWith('_ON_DEMAND')) return true;
  return problem?.onDemand === true && ON_DEMAND_SOFT_STATUSES.has(problem?.status);
}

export function findOperationalProblems(payload) {
  validateCompactHealthPayload(payload);
  return Object.entries(payload.problems ?? {})
    .filter(([, problem]) => !isOnDemandProblem(problem))
    .map(([name, problem]) => ({
      name,
      status: problem?.status ?? 'UNKNOWN',
      records: problem?.records,
      ...(Number.isFinite(problem?.seedAgeMin)
        ? { seedAgeMin: problem.seedAgeMin }
        : {}),
      ...(Number.isFinite(problem?.maxStaleMin)
        ? { maxStaleMin: problem.maxStaleMin }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function validateAcceptanceBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('Acceptance baseline must be an object');
  }
  if (typeof baseline.expiresAt !== 'string' || Number.isNaN(Date.parse(baseline.expiresAt))) {
    throw new Error('Acceptance baseline must carry an ISO expiresAt date');
  }
  if (!Array.isArray(baseline.acknowledged)) {
    throw new Error('Acceptance baseline must contain an acknowledged array');
  }
  for (const entry of baseline.acknowledged) {
    if (!entry?.name || !entry?.status) {
      throw new Error('Each acknowledged baseline entry needs name and status');
    }
    if (!Number.isInteger(entry.issue)) {
      throw new Error(`Acknowledged baseline entry ${entry.name} needs an owner issue number`);
    }
    for (const field of ['minRecords', 'maxSeedAgeMin']) {
      if (entry[field] === undefined) continue;
      if (!Number.isFinite(entry[field]) || entry[field] < 0) {
        throw new Error(
          `Acknowledged baseline entry ${entry.name} has a non-numeric ${field} bound`,
        );
      }
    }
  }
  return baseline;
}

/**
 * Decide whether a live problem has degraded PAST the state that was accepted.
 *
 * An acknowledgement is a statement about a measured level, not a blanket
 * amnesty for a name:status pair. Without a bound the entry suppresses the row
 * no matter how much worse it gets, which is the failure mode this closes:
 * portwatchPortActivity was acknowledged at 159 of 174 countries and went on
 * reporting `acknowledged` at 128, and crossStraitActivityJapanMod was
 * acknowledged at a 1341-minute age and went on reporting `acknowledged` at
 * 13330. Both are the same shape as the marketImplications blind spot the
 * ON_DEMAND_KEYS policy block in api/health.js exists to prevent: a suppression
 * that stops measuring the thing it suppressed.
 *
 * Bounds are OPT-IN. An entry without them keeps the old exact-match behaviour,
 * so adding this mechanism cannot turn rows red on its own — a bound only ever
 * exists because somebody wrote down the level they accepted.
 */
export function findAcknowledgementBreach(problem, entry) {
  if (Number.isFinite(entry.minRecords) && Number.isFinite(problem.records)) {
    if (problem.records < entry.minRecords) {
      return `records fell to ${problem.records}, below the acknowledged floor of ${entry.minRecords}`;
    }
  }
  if (Number.isFinite(entry.maxSeedAgeMin) && Number.isFinite(problem.seedAgeMin)) {
    if (problem.seedAgeMin > entry.maxSeedAgeMin) {
      return `age rose to ${problem.seedAgeMin}m, past the acknowledged ceiling of ${entry.maxSeedAgeMin}m`;
    }
  }
  return null;
}

/**
 * Split live problems against the acknowledged baseline.
 *
 * `blocking` fails the gate. `acknowledged` is a known-degraded source with an
 * owner issue, reported but not fatal. `cleared` is a baseline entry that no
 * longer appears in health — reported as a prompt to prune, but deliberately
 * NOT fatal, because several of these sources flap between polls and a
 * clear-on-recovery failure would make the monitor red on exactly the runs that
 * prove things improved. `expiresAt` is the anti-rot mechanism instead: the
 * whole baseline must be re-reviewed on a date, or the gate fails.
 *
 * A matched entry whose declared bound is breached is a REGRESSION: it joins
 * `blocking` (so the run exits non-zero) and is also surfaced in `regressed`
 * so the report can say which acknowledged level was left behind, rather than
 * printing it as an anonymous new problem.
 */
export function applyAcceptanceBaseline(problems, baseline, now = Date.now()) {
  validateAcceptanceBaseline(baseline);
  const accepted = new Map(
    baseline.acknowledged.map((entry) => [`${entry.name}:${entry.status}`, entry]),
  );
  const seen = new Set();
  const blocking = [];
  const acknowledged = [];
  const regressed = [];
  for (const problem of problems) {
    const key = `${problem.name}:${problem.status}`;
    const entry = accepted.get(key);
    if (entry) {
      // The row is still "seen" either way. A regression is the acknowledged
      // source getting worse, not the acknowledgement disappearing, so it must
      // not also be reported as `recovered` on the same run.
      seen.add(key);
      const breach = findAcknowledgementBreach(problem, entry);
      if (breach) {
        const regression = { ...problem, issue: entry.issue, breach };
        regressed.push(regression);
        blocking.push(regression);
      } else {
        acknowledged.push({ ...problem, issue: entry.issue });
      }
    } else {
      blocking.push(problem);
    }
  }
  const cleared = baseline.acknowledged
    .filter((entry) => !seen.has(`${entry.name}:${entry.status}`))
    .map((entry) => ({ name: entry.name, status: entry.status, issue: entry.issue }));
  const expired = Date.parse(baseline.expiresAt) < now;
  return { blocking, acknowledged, cleared, regressed, expired, expiresAt: baseline.expiresAt };
}

function readAcceptanceBaseline() {
  return JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
}

function describeProblem(problem) {
  const freshness = Number.isFinite(problem.seedAgeMin)
    ? ` age=${problem.seedAgeMin}m max=${problem.maxStaleMin ?? 'unknown'}m`
    : '';
  return `${problem.name}: status=${problem.status} records=${problem.records ?? 'unknown'}${freshness}`;
}

/**
 * Pure renderer for one acceptance run. Kept separate from main() so the
 * ORDER of the report is testable without a network round trip — the bug this
 * shape closes was an early `return` on expiry that suppressed the blocking
 * list, and no assertion over the pure split functions could have seen it.
 */
export function formatAcceptanceReport(
  { blocking, acknowledged, cleared, expired, expiresAt },
  checkedAt,
) {
  const info = [
    ...acknowledged.map((problem) => `- acknowledged (#${problem.issue}): ${describeProblem(problem)}`),
    // Issue #87: report the recovery, do NOT advise the prune. `cleared` is
    // deliberately non-fatal because these sources flap between polls, and a
    // single clean run is the same evidence either way. The old text asked for
    // the row to be removed on that one run; crossStraitActivityJapanMod was
    // pruned on 2026-08-19 07:06Z on exactly this advice and blocked the gate
    // again twenty hours later as a new problem. expiresAt is the review that
    // sees the whole file at once, so it owns the prune.
    ...cleared.map((entry) =>
      `- recovered: ${entry.name}:${entry.status} no longer reported (#${entry.issue}). Leave the row; the ${expiresAt} re-review decides whether it goes.`),
  ];
  const errors = [];

  // The actionable list comes BEFORE any terminal condition. Expiry is the run
  // where an operator most needs to see what is actually broken.
  if (blocking.length > 0) {
    errors.push(`Ingestion operational acceptance failed: ${blocking.length} unacknowledged problem(s).`);
    errors.push(
      ...blocking.map((problem) =>
        problem.breach
          ? `- regressed beyond acknowledgement (#${problem.issue}): ${describeProblem(problem)} — ${problem.breach}`
          : `- ${describeProblem(problem)}`,
      ),
    );
  }
  if (expired) {
    errors.push(
      `Ingestion operational acceptance failed: the accepted-problem baseline expired on ${expiresAt}. Re-review scripts/seed-freshness-baseline.json and set a new expiresAt.`,
    );
  }
  if (errors.length === 0) {
    info.push(
      `Ingestion operational acceptance passed at ${checkedAt || 'unknown time'}: no unacknowledged health problems (${acknowledged.length} acknowledged).`,
    );
  }
  return { info, errors, failed: errors.length > 0 };
}

async function main() {
  const healthUrl = process.env.HEALTH_URL || DEFAULT_HEALTH_URL;
  const response = await fetch(healthUrl, {
    headers: { 'User-Agent': 'worldmonitor-seed-freshness-monitor/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Compact health request failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const report = formatAcceptanceReport(
    applyAcceptanceBaseline(findOperationalProblems(payload), readAcceptanceBaseline()),
    payload.checkedAt,
  );
  for (const line of report.info) console.log(line);
  for (const line of report.errors) console.error(line);
  if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
