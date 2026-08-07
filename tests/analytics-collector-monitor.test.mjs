import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  COLLECTOR_PROBES,
  buildProbeRequest,
  evaluateProbeResult,
  extractCollectorFailureMetadata,
  isBotFilteredBody,
  runCollectorChecks,
  summarizeProbeFailures,
  summarizeWriteCanaryResults,
} from '../scripts/check-analytics-collector.mjs';

const receiptBody = JSON.stringify({ cache: 'cache-id', sessionId: 'session-id', visitId: 'visit-id' });
const OK_RECEIPT = { status: 200, body: receiptBody };
const P2002_BODY = JSON.stringify({
  error: { errorObject: { code: 'P2002', meta: { target: ['session_data_pkey'] } } },
});

/**
 * Healthy response for the one non-write probe. `/api/send` is POST-only, so a
 * GET against the mounted route answers 405 from its own method guard.
 */
const healthyLiveness = () => ({ status: 405 });

const probeByName = (name) => COLLECTOR_PROBES.find((probe) => probe.name === name);

describe('scheduled analytics collector monitor', () => {
  it('accepts the live shape of a healthy collector', () => {
    assert.equal(evaluateProbeResult(probeByName('ingest-route'), { status: 405 }), null);
    // The route rejects a bodyless GET with 400 on some paths through the
    // Worker; both answers prove the same thing — the route is mounted.
    assert.equal(evaluateProbeResult(probeByName('ingest-route'), { status: 400 }), null);
    for (const probe of COLLECTOR_PROBES.filter((candidate) => candidate.writeCanary)) {
      assert.equal(evaluateProbeResult(probe, OK_RECEIPT), null);
    }
  });

  it('alerts when the route is gone or the host is down', () => {
    // An unmounted /api/send falls through to the rewrite table, which answers
    // 404 — never the 405 the route's own method guard returns.
    assert.match(evaluateProbeResult(probeByName('ingest-route'), { status: 404 }), /HTTP 404/);
    // Cloudflare 5xx, the shape of the #5565 outage, on every path.
    for (const probe of COLLECTOR_PROBES) {
      assert.match(evaluateProbeResult(probe, { status: 502 }), /HTTP 502/);
    }
    assert.match(
      evaluateProbeResult(probeByName('ingest-route'), { error: 'The operation was aborted' }),
      /request failed/,
    );
  });

  it('sends realistic writes that cover both collector branches', () => {
    assert.equal(probeByName('ingest-route').path, '/api/send');
    assert.equal(buildProbeRequest(probeByName('ingest-route')).method, 'GET');

    const writeCanaries = COLLECTOR_PROBES.filter((candidate) => candidate.writeCanary);
    const payloads = writeCanaries.map((probe) => {
      const request = buildProbeRequest(probe);
      assert.equal(probe.path, '/api/send');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['Content-Type'], 'application/json');
      assert.match(request.headers['User-Agent'], /^Mozilla\/5\.0 /);
      return JSON.parse(request.body);
    });

    // handleAnalyticsCollect branches on `type`. Events and identifies take
    // different paths through it, so a burst of one kind leaves the other
    // unmeasured — and two identifies carrying the same data key are what put
    // the identify path under concurrency rather than one call at a time.
    const identifies = payloads.filter((body) => body.type === 'identify');
    assert.ok(identifies.length >= 2, 'at least two identify writes are required');
    const contendedKeys = identifies.map((body) => Object.keys(body.payload.data).join(','));
    assert.equal(
      new Set(contendedKeys).size,
      1,
      'contending identify writes must target the SAME data key',
    );

    assert.ok(payloads.some((body) => body.type === 'event' && body.payload.name === 'pageview'));
    assert.ok(payloads.some((body) => body.payload.name === 'collector-write-canary'));

    // One session and one visit across the burst, and a hostname that keeps
    // these rows out of the product numbers — every point the collector writes
    // carries hostname, so a query can drop the canary by name.
    assert.equal(new Set(payloads.map((body) => body.payload.id)).size, 1);
    assert.equal(new Set(payloads.map((body) => body.payload.visitId)).size, 1);
    for (const body of payloads) {
      assert.equal(body.payload.hostname, 'analytics-canary.worldmonitor.sibt.ai');
    }
  });

  it('probes this site, not the host the upstream project runs', () => {
    const source = readFileSync(new URL('../scripts/check-analytics-collector.mjs', import.meta.url), 'utf8');
    // Block comments only: the header docblock names the dead host on purpose,
    // and a `//` strip would eat the `https://` out of every URL below it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /DEFAULT_COLLECTOR_ORIGIN\s*=\s*'https:\/\/worldmonitor\.sibt\.ai'/);
    assert.doesNotMatch(
      code,
      /abacus\.worldmonitor\.app/,
      'the hosted Umami origin is gone — a probe against it is red forever',
    );
  });

  it('does not publish a stable canary session id an outsider can squat on', () => {
    const source = readFileSync(new URL('../scripts/check-analytics-collector.mjs', import.meta.url), 'utf8');
    assert.match(source, /randomUUID\(\)/, 'the canary session id must be generated per run');
    assert.doesNotMatch(
      source,
      /ANALYTICS_CANARY_SESSION_ID\s*=\s*['"]/,
      '/api/send is unauthenticated and this repo is public — a literal session id is a griefing target',
    );
  });

  it('blames the probe, not the collector, when the WAF rejects the User-Agent', () => {
    // A bare `curl/*` agent 403s on this host — that is a monitor bug, and the
    // alert has to say so or it reads as an outage.
    const reason = evaluateProbeResult(probeByName('ingest-route'), { status: 403 });
    assert.match(reason, /User-Agent/);
    assert.match(reason, /not the collector/);
  });

  it('rejects bot-filtered and malformed write-canary receipts despite HTTP 200', () => {
    const writeCanary = probeByName('write-canary-event');
    // A bot-filtered 200 must be NAMED as such. Reporting it as a generic
    // missing receipt blames the write path for a drop something in front of
    // the collector made on purpose, which sends the on-call reader looking for
    // a fault that is not there. The canary sends a browser User-Agent, so this
    // firing at all means the heuristic now matches us and the probe has
    // stopped measuring the write path it claims to measure.
    assert.match(
      evaluateProbeResult(writeCanary, { status: 200, body: '{"beep":"boop"}' }),
      /bot-filtered/,
    );
    assert.match(
      evaluateProbeResult(writeCanary, { status: 200, body: '{not json' }),
      /receipt was not valid JSON/,
    );
  });

  it('detects the bot-filter sentinel without matching a real receipt', () => {
    assert.equal(isBotFilteredBody('{"beep":"boop"}'), true);
    assert.equal(isBotFilteredBody('  {"beep":"boop"}  '), true);
    // A genuine receipt is never the sentinel, even if a field value happens to
    // spell one of the sentinel's words — this must key off the parsed `beep`
    // property, not a substring scan an upstream value could forge.
    assert.equal(isBotFilteredBody(receiptBody), false);
    assert.equal(
      isBotFilteredBody(JSON.stringify({ cache: 'beep', sessionId: 'boop', visitId: 'v' })),
      false,
    );
    assert.equal(isBotFilteredBody('{"beep":"something-else"}'), false);
    assert.equal(isBotFilteredBody('{not json'), false);
    assert.equal(isBotFilteredBody(''), false);
    assert.equal(isBotFilteredBody(undefined), false);
    assert.equal(isBotFilteredBody(null), false);
  });

  it('surfaces database failure metadata without retaining the analytics payload', () => {
    // Our collector writes to Analytics Engine and cannot answer this shape.
    // The check stays for whatever sits in front of the endpoint later, and it
    // must keep the constraint name while dropping the row it was writing.
    const body = JSON.stringify({
      error: {
        errorObject: {
          code: 'P2002',
          meta: { target: ['session_data_pkey'] },
          message: 'Unique constraint failed on the fields: (session_data_id)',
          stack: 'not emitted',
        },
      },
    });

    assert.deepEqual(extractCollectorFailureMetadata(body), {
      prismaCode: 'P2002',
      constraint: 'session_data_pkey',
    });
    const reason = evaluateProbeResult(probeByName('write-canary-identify-a'), { status: 500, body });
    assert.match(reason, /HTTP 500/);
    assert.match(reason, /P2002/);
    assert.match(reason, /session_data_pkey/);
    assert.doesNotMatch(reason, /session_data_id/);
  });

  it('computes the write failure rate over every attempt, not the survivor', () => {
    // Six attempts (two bursts of three), two of which failed.
    const attempts = [
      { name: 'write-canary-identify-a', reason: null },
      { name: 'write-canary-identify-b', reason: 'HTTP 500 (expected 200) — Prisma P2002 constraint session_data_pkey' },
      { name: 'write-canary-pageview', reason: null },
      { name: 'write-canary-identify-a', reason: null },
      { name: 'write-canary-identify-b', reason: 'request failed: fetch failed' },
      { name: 'write-canary-pageview', reason: null },
    ];

    assert.deepEqual(summarizeWriteCanaryResults(attempts), {
      total: 6,
      failed: 2,
      failureRate: 2 / 6,
      failures: [
        { name: 'write-canary-identify-b', reason: 'HTTP 500 (expected 200) — Prisma P2002 constraint session_data_pkey' },
        { name: 'write-canary-identify-b', reason: 'request failed: fetch failed' },
      ],
    });
  });

  it('fires every write canary concurrently, in each burst', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const burstSizes = [];
    let pending = 0;

    const report = await runCollectorChecks({
      sleep: async () => {},
      runner: async (_origin, probe) => {
        if (!probe.writeCanary) return healthyLiveness(probe);
        inFlight += 1;
        pending += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        if (inFlight === 0) { burstSizes.push(pending); pending = 0; }
        return OK_RECEIPT;
      },
    });

    const canaryCount = COLLECTOR_PROBES.filter((probe) => probe.writeCanary).length;
    assert.equal(maxInFlight, canaryCount, 'every canary in a burst must be in flight together');
    assert.ok(burstSizes.length > 1, 'the canary must run more than one burst');
    assert.ok(
      burstSizes.every((size) => size === canaryCount),
      `every burst must stay concurrent, saw ${JSON.stringify(burstSizes)}`,
    );
    assert.equal(report.alerting, false);
  });

  it('still reports a non-zero write failure rate when a later attempt succeeds', async () => {
    // The regression this monitor exists for: a per-probe first-success-wins
    // retry reports 0.0% through exactly the incident it should catch.
    let identifyAttempts = 0;
    const report = await runCollectorChecks({
      sleep: async () => {},
      runner: async (_origin, probe) => {
        if (!probe.writeCanary) return healthyLiveness(probe);
        if (probe.name === 'write-canary-identify-b') {
          identifyAttempts += 1;
          if (identifyAttempts === 1) return { status: 500, body: P2002_BODY };
        }
        return OK_RECEIPT;
      },
    });

    assert.ok(report.writeSummary.failed > 0, 'a failed attempt must survive a later success');
    assert.ok(report.writeSummary.failureRate > 0, 'the reported rate must not be 0.0%');
    assert.equal(report.alerting, true, 'any failed write attempt is actionable');
    assert.match(report.writeSummary.failures[0].reason, /P2002/);
  });

  it('exits non-zero when the write path is dead even though liveness is green', async () => {
    const report = await runCollectorChecks({
      sleep: async () => {},
      runner: async (_origin, probe) => {
        if (!probe.writeCanary) return healthyLiveness(probe);
        return { status: 500, body: P2002_BODY };
      },
    });

    assert.equal(report.livenessFailures.length, 0, 'liveness is deliberately green here');
    assert.equal(report.writePathDead, true);
    assert.equal(report.alerting, true, 'a dead write path must alert on its own');
  });

  it('alerts on a single rejected write inside an otherwise clean burst', async () => {
    // One collision is enough to fail the acceptance contract: the collector
    // must accept every realistic POST in every burst and answer each with a
    // full receipt.
    let seen = 0;
    const report = await runCollectorChecks({
      sleep: async () => {},
      runner: async (_origin, probe) => {
        if (!probe.writeCanary) return healthyLiveness(probe);
        seen += 1;
        if (seen === 1) return { status: 500, body: P2002_BODY };
        return OK_RECEIPT;
      },
    });

    assert.ok(report.writeSummary.failureRate > 0, 'the rate is still reported');
    assert.equal(report.hasWriteFailures, true);
    assert.equal(report.alerting, true);
  });

  it('reports every failing probe, in probe order, and nothing else', () => {
    const failures = summarizeProbeFailures(COLLECTOR_PROBES, {
      'ingest-route': { error: 'fetch failed' },
      'write-canary-identify-a': OK_RECEIPT,
      'write-canary-identify-b': OK_RECEIPT,
      'write-canary-pageview': { status: 500 },
      'write-canary-event': OK_RECEIPT,
    });
    assert.deepEqual(
      failures.map((failure) => failure.name),
      ['ingest-route', 'write-canary-pageview'],
    );
    assert.match(failures[0].reason, /fetch failed/);
    assert.match(failures[1].reason, /HTTP 500/);
  });

  it('refuses malformed probes and results instead of passing them', () => {
    assert.throws(() => evaluateProbeResult(null, { status: 200 }), /probe must be an object/);
    assert.throws(
      () => evaluateProbeResult({ name: 'x', okStatuses: [] }, { status: 200 }),
      /okStatuses/,
    );
    assert.throws(() => evaluateProbeResult(probeByName('ingest-route'), null), /result must be/);
  });

  it('runs on a schedule and invokes the monitor script without a main-green gate', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/analytics-collector-monitor.yml', import.meta.url),
      'utf8',
    );

    assert.match(workflow, /schedule:/);
    assert.match(workflow, /cron:\s*['"]\*\/5 \* \* \* \*['"]/);
    assert.match(workflow, /actions\/setup-node@[a-f0-9]+/);
    assert.match(workflow, /node-version:\s*['"]24['"]/);
    assert.match(workflow, /node scripts\/check-analytics-collector\.mjs/);
    // The gate that seed-freshness-monitor.yml uses must NOT appear here.
    assert.doesNotMatch(workflow, /context\s*==\s*"gate"/);
  });
});
