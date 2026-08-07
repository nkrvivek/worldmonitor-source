#!/usr/bin/env node

/**
 * Scheduled liveness probe for this site's own analytics collector
 * (worker/routes/analytics-collect.ts, served at /api/send).
 *
 * Why this exists: on 2026-07-20 the upstream project's hosted Umami collector
 * OOM-died and its host neither restarted it nor flipped the deployment off
 * `SUCCESS`, so nothing alerted. Every product-analytics event was dropped for
 * 4 days (~1.1M events), found by hand while asking an unrelated question about
 * a funnel. See #5565.
 *
 * The collector moved into the Worker and the third-party host is gone, but the
 * lesson is not: a green deploy says nothing about whether writes land. So the
 * probes stayed, repointed at our own endpoint, and the Umami-only ones — the
 * heartbeat route, the hosted tracker script — went with the host that served
 * them. What is left is what our collector can actually answer: the route is
 * mounted, and a realistic POST comes back with a usable write receipt.
 */

import { randomUUID } from 'node:crypto';
import { isMainModule } from './lib/main-module.mjs';

import {
  extractCollectorFailureMetadata,
  isBotFilteredBody,
  WRITE_RECEIPT_FIELDS,
} from '../shared/collector-failure-metadata.js';

export { extractCollectorFailureMetadata, isBotFilteredBody };

const DEFAULT_COLLECTOR_ORIGIN = 'https://worldmonitor.sibt.ai';
const ANALYTICS_CANARY_HOSTNAME = 'analytics-canary.worldmonitor.sibt.ai';
/**
 * Generated per run, not hard-coded. The repo is public, so a fixed session key
 * published alongside the (necessarily unauthenticated) `/api/send` endpoint is
 * a stable target an outsider can contend with to force false monitor pages.
 * A fresh UUID keeps the same-session property for THIS run's probes while
 * giving nobody a key to squat on, and satisfies the collector's id filter
 * (safeId, /^[A-Za-z0-9_-]{8,64}$/).
 */
const ANALYTICS_CANARY_SESSION_ID = randomUUID();
/** One visit per run, the same shape the browser tracker mints per page load. */
const ANALYTICS_CANARY_VISIT_ID = randomUUID();

/**
 * Cloudflare's WAF 403s a bare `curl/*` User-Agent on this host (verified
 * 2026-07-24: `curl` default → 403, named agent → 200). A probe without a
 * named agent alerts on a perfectly healthy collector, so this is required,
 * not cosmetic.
 */
const USER_AGENT = 'worldmonitor-analytics-collector-monitor/1.0';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;

/**
 * Write canaries are fired as synchronized BURSTS, not through the liveness
 * retry helper. Retrying one failing probe on its own would both (a) hide the
 * failure the moment a lone retry succeeds and (b) destroy the concurrency that
 * is the entire point of the probe. Every burst re-fires the whole set at once
 * and every attempt is retained for the rate.
 */
const WRITE_CANARY_BURSTS = 3;
const WRITE_BURST_DELAY_MS = 3_000;

const ANALYTICS_CANARY_PAYLOAD = Object.freeze({
  hostname: ANALYTICS_CANARY_HOSTNAME,
  url: '/__monitor__/analytics-collector',
  referrer: '',
  screen: '1x1',
  language: 'en-US',
  // One session and one visit across the whole burst. The canary hostname is
  // what keeps these rows out of the product numbers: every point the
  // collector writes carries it, so a query can drop them by name.
  id: ANALYTICS_CANARY_SESSION_ID,
  visitId: ANALYTICS_CANARY_VISIT_ID,
});

/** The data key the two concurrent identify probes write. */
const CONTENDED_SESSION_DATA_KEY = 'monitor';

function buildWriteCanaryProbe(name, type, extraPayload = {}) {
  return Object.freeze({
    name,
    path: '/api/send',
    method: 'POST',
    okStatuses: Object.freeze([200]),
    userAgent: BROWSER_USER_AGENT,
    receiptFields: WRITE_RECEIPT_FIELDS,
    writeCanary: true,
    body: Object.freeze({
      type,
      payload: Object.freeze({ ...ANALYTICS_CANARY_PAYLOAD, ...extraPayload }),
    }),
  });
}

/**
 * Four realistic writes, fired together: two identities carrying the same data
 * key, a bare pageview, and a named event with a data blob. Between them they
 * cover both branches the collector has — `identify` and `event` — and the
 * whole set going out at once is what puts the burst through the rate limiter
 * and the receipt path under concurrency rather than one request at a time.
 */
export const ANALYTICS_WRITE_CANARY_PROBES = Object.freeze([
  buildWriteCanaryProbe('write-canary-identify-a', 'identify', {
    data: Object.freeze({ [CONTENDED_SESSION_DATA_KEY]: 'github-actions-a' }),
  }),
  buildWriteCanaryProbe('write-canary-identify-b', 'identify', {
    data: Object.freeze({ [CONTENDED_SESSION_DATA_KEY]: 'github-actions-b' }),
  }),
  buildWriteCanaryProbe('write-canary-pageview', 'event', { name: 'pageview' }),
  buildWriteCanaryProbe('write-canary-event', 'event', {
    name: 'collector-write-canary',
    data: Object.freeze({ source: 'github-actions' }),
  }),
]);

export const COLLECTOR_PROBES = Object.freeze([
  Object.freeze({
    name: 'ingest-route',
    path: '/api/send',
    // The route-mount check from #5565, and the one probe that separates two
    // failures a write canary reports identically: the Worker is serving but
    // the collector route is gone, versus the collector is there and the write
    // itself broke. An unmounted /api/send falls through to the asset probe and
    // then the rewrite table, which answers 404 — never the 405 the route's own
    // method guard returns.
    okStatuses: Object.freeze([400, 405]),
    captureFailureMetadata: true,
  }),
  // Fired as synchronized bursts by runWriteCanaryBursts, NOT through the
  // per-probe liveness retry — see WRITE_CANARY_BURSTS.
  ...ANALYTICS_WRITE_CANARY_PROBES,
]);

/** Build the request shape for one probe without performing network I/O. */
export function buildProbeRequest(probe) {
  const headers = { 'User-Agent': probe.userAgent || USER_AGENT };
  const request = {
    method: probe.method || 'GET',
    headers,
  };
  if (probe.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(probe.body);
  }
  return request;
}

/**
 * Names a database error a failing body carries, when it carries one. Our
 * collector writes to Analytics Engine and has no database to report, so this
 * stays quiet against it. It is shared with the client transport
 * (shared/collector-failure-metadata.js), which classifies whatever the
 * endpoint in front of it answers, and it costs one function call to keep a
 * proxy or a future backend from reporting a 500 as "no reason given".
 */
function formatFailureMetadata(body) {
  const metadata = extractCollectorFailureMetadata(body);
  if (!metadata.prismaCode && !metadata.constraint) return '';
  const details = [
    metadata.prismaCode ? `Prisma ${metadata.prismaCode}` : null,
    metadata.constraint ? `constraint ${metadata.constraint}` : null,
  ].filter(Boolean).join(' ');
  return ` — ${details}`;
}

/**
 * Classify one completed probe attempt. Returns null when healthy, otherwise a
 * human-readable reason for the alert.
 */
export function evaluateProbeResult(probe, result) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    throw new TypeError('probe must be an object');
  }
  if (!Array.isArray(probe.okStatuses) || probe.okStatuses.length === 0) {
    throw new TypeError(`probe ${probe.name} must declare okStatuses`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('result must be an object');
  }

  if (result.error) return `request failed: ${result.error}`;

  if (!probe.okStatuses.includes(result.status)) {
    // 403 is the WAF rejecting the probe itself, not the collector being down.
    // Calling that out keeps a monitor bug from reading as an outage.
    const hint =
      result.status === 403
        ? ' — Cloudflare WAF rejected the probe; check the User-Agent, not the collector'
        : '';
    return `HTTP ${result.status} (expected ${probe.okStatuses.join(' or ')})${hint}${formatFailureMetadata(result.body)}`;
  }

  if (probe.receiptFields) {
    // Checked BEFORE the field loop so the reason names the actual condition.
    // A bot filter answers 200 with `{"beep":"boop"}` and no receipt; reporting
    // that as "receipt missing non-empty string cache" points the reader at a
    // broken write path instead of at the User-Agent. Our own collector does
    // not filter, but Cloudflare sits in front of it and can be made to, and
    // the canary sends a browser User-Agent precisely so it is not caught.
    // Being caught still counts as a probe FAILURE: the write path it exists to
    // measure was never exercised.
    if (isBotFilteredBody(result.body)) {
      return `HTTP ${result.status} but the write was bot-filtered before it reached the collector (probe User-Agent now matches a bot heuristic; the write path was never exercised)`;
    }
    let receipt;
    try {
      receipt = JSON.parse(result.body);
    } catch {
      return `HTTP ${result.status} but write receipt was not valid JSON`;
    }
    for (const field of probe.receiptFields) {
      if (typeof receipt?.[field] !== 'string' || receipt[field].trim() === '') {
        return `HTTP ${result.status} but write receipt missing non-empty string ${field}`;
      }
    }
  }

  return null;
}

/** Collect the probes that failed, preserving probe order for stable output. */
export function summarizeProbeFailures(probes, resultsByName) {
  return probes
    .map((probe) => ({ probe, reason: evaluateProbeResult(probe, resultsByName[probe.name]) }))
    .filter(({ reason }) => reason !== null)
    .map(({ probe, reason }) => ({ name: probe.name, path: probe.path, reason }));
}

/**
 * Summarize write-path health over EVERY attempt, not just the surviving one.
 *
 * The rate has to be attempt-level or it cannot represent the condition this
 * monitor exists for. With a per-probe first-success-wins retry, a 4-8%
 * per-request failure rate reports 0.0% about 99.95% of the time — the monitor
 * would print a clean bill of health through exactly the kind of intermittent
 * write failure it exists to catch (#5715).
 *
 * @param {Array<{ name: string, reason: string | null }>} attempts
 */
export function summarizeWriteCanaryResults(attempts) {
  const failures = attempts.filter(({ reason }) => reason !== null);
  return {
    total: attempts.length,
    failed: failures.length,
    failureRate: attempts.length === 0 ? 0 : failures.length / attempts.length,
    failures,
  };
}

async function runProbe(origin, probe) {
  const url = new URL(probe.path, origin).toString();
  try {
    const response = await fetch(url, {
      ...buildProbeRequest(probe),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Read only bodies needed for an assertion or sanitized failure metadata.
    // Never print this body: an error page from whatever answered can carry a
    // stack and request-adjacent details.
    const body = probe.receiptFields || probe.captureFailureMetadata
      ? await response.text()
      : '';
    return { status: response.status, body };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Retry before alerting so a single transient blip (deploy restart, edge
 * hiccup) does not page anyone. A sustained failure is what matters: the
 * outage this monitor exists for lasted four days.
 *
 * Liveness probes only — write canaries deliberately do NOT come through here.
 */
async function runProbeWithRetries(origin, probe, runner, sleep) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    last = await runner(origin, probe);
    if (evaluateProbeResult(probe, last) === null) return last;
    if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return last;
}

/**
 * Fire every write canary at once, repeatedly. Each burst is itself concurrent,
 * so a retry still exercises session-data contention instead of degrading into
 * isolated sequential writes.
 */
async function runWriteCanaryBursts(origin, probes, runner, sleep) {
  const attempts = [];
  const lastByName = {};
  for (let burst = 1; burst <= WRITE_CANARY_BURSTS; burst += 1) {
    const results = await Promise.all(probes.map((probe) => runner(origin, probe)));
    probes.forEach((probe, index) => {
      const result = results[index];
      lastByName[probe.name] = result;
      attempts.push({ name: probe.name, reason: evaluateProbeResult(probe, result) });
    });
    if (burst < WRITE_CANARY_BURSTS) await sleep(WRITE_BURST_DELAY_MS);
  }
  return { attempts, lastByName };
}

/**
 * Run every probe and decide the outcome. Split out of `main()` so the alerting
 * contract — concurrent canary dispatch, the attempt-level rate, and the exit
 * decision — is reachable from tests with an injected runner.
 */
export async function runCollectorChecks({
  origin = DEFAULT_COLLECTOR_ORIGIN,
  runner = runProbe,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const livenessProbes = COLLECTOR_PROBES.filter((probe) => !probe.writeCanary);
  const writeProbes = COLLECTOR_PROBES.filter((probe) => probe.writeCanary);

  const [livenessEntries, writeRun] = await Promise.all([
    Promise.all(
      livenessProbes.map(async (probe) => [
        probe.name,
        await runProbeWithRetries(origin, probe, runner, sleep),
      ]),
    ),
    runWriteCanaryBursts(origin, writeProbes, runner, sleep),
  ]);

  const resultsByName = { ...Object.fromEntries(livenessEntries), ...writeRun.lastByName };
  const livenessFailures = summarizeProbeFailures(livenessProbes, resultsByName);
  const writeSummary = summarizeWriteCanaryResults(writeRun.attempts);

  // The write canary is the acceptance gate: the collector must accept every
  // realistic POST in every burst and answer each with a full receipt. A single
  // failed write is actionable; the rate stays in the report for diagnosis, not
  // as a tolerance band.
  const writePathDead = writeSummary.total > 0 && writeSummary.failed === writeSummary.total;
  const hasWriteFailures = writeSummary.failed > 0;

  return {
    origin,
    resultsByName,
    livenessFailures,
    writeSummary,
    writePathDead,
    hasWriteFailures,
    alerting: livenessFailures.length > 0 || hasWriteFailures,
  };
}

function reportCollectorChecks(report) {
  const { origin, livenessFailures, writeSummary } = report;
  const writeRate = `${(writeSummary.failureRate * 100).toFixed(1)}%`;
  console.log(
    `Analytics collector write canary: ${writeSummary.failed}/${writeSummary.total} attempts failed (${writeRate}) across ${WRITE_CANARY_BURSTS} concurrent bursts.`,
  );

  if (!report.alerting) {
    console.log(`Analytics collector healthy at ${origin}: ${COLLECTOR_PROBES.length} probes OK.`);
    return;
  }

  console.error(`Analytics collector alert at ${origin}:`);
  if (livenessFailures.length > 0) {
    console.error(`- ${livenessFailures.length} liveness probe(s) failing after ${ATTEMPTS} attempts.`);
    for (const failure of livenessFailures) {
      console.error(`  - ${failure.name} (${failure.path}): ${failure.reason}`);
    }
    console.error(
      '  Events are being dropped while this is red. Check the deployed Worker and worker/routes/analytics-collect.ts — a green deploy does not mean writes land (#5565).',
    );
  }
  if (report.writePathDead) {
    console.error('- Write path is fully down: every canary attempt failed.');
  } else if (report.hasWriteFailures) {
    console.error(
      `- Write canary has ${writeSummary.failed}/${writeSummary.total} failed attempts; any failed POST is actionable.`,
    );
  }
  // Deduplicate by reason so a race that hits every burst reads as one line.
  const seen = new Set();
  for (const failure of writeSummary.failures) {
    const line = `  - ${failure.name}: ${failure.reason}`;
    if (seen.has(line)) continue;
    seen.add(line);
    console.error(line);
  }
}

async function main() {
  const report = await runCollectorChecks({
    origin: process.env.ANALYTICS_COLLECTOR_ORIGIN || DEFAULT_COLLECTOR_ORIGIN,
  });
  reportCollectorChecks(report);
  if (report.alerting) process.exitCode = 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
