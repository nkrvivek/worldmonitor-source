---
title: "Analytics Collector Operations"
description: "Operational contract for this site's own analytics collector and its scheduled write canary."
---

# Analytics Collector Operations

Product analytics are collected by this site's own Worker route,
[`worker/routes/analytics-collect.ts`](../worker/routes/analytics-collect.ts),
served at `POST /api/send` and writing to one Analytics Engine dataset. There
is no third-party collector, no tracker script from another host, and no
database behind it.

A green Worker deployment is not a write-path health signal. The collector can
be deployed and still drop every write, which is how the upstream project lost
about 1.1M events over four days before anyone noticed (#5565). The canary
below is what answers the question a deployment status cannot.

## Write-path contract

- Every success answer carries a real write receipt: `cache`, `sessionId` and
  `visitId`, all non-empty strings.
  [`src/services/analytics-collector-transport.ts`](../src/services/analytics-collector-transport.ts)
  treats a 2xx whose receipt is missing any of the three as undelivered, so the
  response shape is part of the contract, not an implementation detail.
- [`scripts/check-analytics-collector.mjs`](../scripts/check-analytics-collector.mjs)
  checks the route is mounted, then fires four realistic writes together: two
  `identify` calls sharing one data key, a bare pageview, and a named event
  with a data blob. They go out as three synchronized bursts, not as retried
  single requests — retrying one failing probe alone would hide the failure the
  moment a lone retry succeeded, and would destroy the concurrency the probe
  exists to create.
- Any failed attempt fails the monitor. A mounted route does not override a red
  write canary.
- The probes carry a fresh session id per run rather than a fixed one. The repo
  is public and `/api/send` is necessarily unauthenticated, so a published key
  is a target an outsider can contend with to force false pages.
- Every canary row carries the hostname `analytics-canary.worldmonitor.sibt.ai`,
  so a query can drop them by name and keep them out of the product numbers.
- The probe sends a named `User-Agent`. Cloudflare's WAF answers 403 to a bare
  `curl/*` on this host, so a probe without one alerts on a healthy collector.

## Monitor

[`.github/workflows/analytics-collector-monitor.yml`](../.github/workflows/analytics-collector-monitor.yml)
runs the check every five minutes. It is deliberately not gated on a green
`main`: the collector's health does not depend on repo state, and a gate is one
more way for the monitor itself to go quiet.

The client's own delivery-health report lands at `POST /api/analytics-health`.
It records what the browser saw, which is the other half of the picture the
server-side canary cannot reach.

## Related

- [`docs/solutions/integration-issues/umami-answers-http-200-when-it-drops-a-bot-write.md`](solutions/integration-issues/umami-answers-http-200-when-it-drops-a-bot-write.md)
  — the 200-with-a-dropped-write case the transport still guards against.
