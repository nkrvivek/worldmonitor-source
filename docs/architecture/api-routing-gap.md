# Which /api paths the Worker does not answer

Measured 2026-08-06 01:15 AM PT (08:15Z) against `https://worldmonitor.sibt.ai`.

The Worker routes the 35 sebuf domain prefixes through
`worker/routes/domains.ts`, plus a handful of named modules — bootstrap,
payments, mcp, oauth, agent, health, analytics, ais-snapshot, counter-read,
social-preview, wm-session. Every other `/api/*` path falls through to the
`UPSTREAM_API_ORIGIN` proxy, which points at `vercel-origin.worldmonitor.app`.
This fork does not control that host, so a fall-through is a 404, not a proxy.

## Method

1. `git grep -oh -E "/api/[a-zA-Z0-9._/-]+" -- 'src/**' ':!src/generated'`
   gives every `/api/…` literal the SPA holds. 120 distinct paths.
2. Drop 10 that are not first-party endpoints (a vendor SDK path, a docs
   filename, dev-only string fragments, prefixes with no path after them).
3. `curl` each remaining path against the live host and record the status.

## Result

| Status | Count | Reading |
|---|---|---|
| 401 | 60 | Routed. Auth gate answered. |
| 405 | 8 | Routed. Wrong method for a bare GET probe. |
| 200 | 3 | Routed and open. |
| 302 | 1 | Routed. |
| 404 | 37 | Not routed. |

Of the 37, **26 already have a handler in `api/`** — the file is in the repo
and its default export is a web-standard `(Request) => Response`, same shape
the existing route modules call. Porting one is a table entry plus a route
registration, not a rewrite.

## What shipped

Two batches closed 24 of those 26. `worker/routes/plain-api.ts` now holds 25
paths — the 24 plus `/api/slack/oauth/callback`, which the grep never found
because Slack redirects the browser there rather than the SPA linking it.

Batch 1 (`23497180c`) took the 11 plain JS handlers. Batch 2 (`b54f75a6f`)
took the 14 TypeScript ones plus the Slack callback. Both are in `main`, and
Worker version `93d3a1fd` carries them live.

Re-probed 2026-08-06 01:36 AM PT (08:36Z). Every one of the 25 answers from
the Worker; **none returns 404**:

```
200  /api/fwdstart  /api/slack/oauth/callback  /api/supply-chain/hormuz-tracker  /api/version
302  /api/download
400  /api/reverse-geocode  /api/youtube/live          missing required query param
401  /api/latest-brief  /api/mcp-proxy  /api/notification-channels  /api/referral/me
     /api/rss-proxy  /api/symbol-search  /api/user-prefs  /api/user/mcp-quota
405  /api/chat-analyst  /api/invalidate-user-api-key-cache  /api/notify
     /api/skills/fetch-agentskills  /api/slack/oauth/start  /api/user/mcp-revoke
503  /api/gpsjam  /api/oref-alerts                   handler says no data source
404  /api/opensky  /api/telegram-feed                relay path not ported, see below
```

The first probe run, taken seconds after deploy, showed seven 404s that all
cleared on the second run. Give the edge a minute before reading a result.

### Two held back on purpose

`api/discord/oauth/{start,callback}.ts` — the Discord notification channel is
being taken out. Routing it would ship a surface we intend to drop.

`api/widget-agent.ts` — it proxies `https://proxy.worldmonitor.app`, a relay
this fork does not run. Routing it turns a 404 into a failed proxy.

Both are pinned false in `tests/worker/plain-api-route.test.mts`, so neither
gets added back without someone deciding to.

### The two that used to answer 522

`/api/opensky` and `/api/telegram-feed` both read `WS_RELAY_URL`, which
`wrangler.jsonc` sets to `https://worldmonitor.sibt.ai` — the site itself. A
Worker fetching its own hostname is a subrequest loop: Cloudflare declines it
rather than routing back through, so both answered
`{"error":"Upstream error: HTTP 522","status":522}` and each call spent its
timeout getting there.

Every relay call now goes through a swappable `relayFetch`, and
`worker/index.ts` points it at `relayFetchViaDurableObject`. `/ais/snapshot`
reaches the Durable Object; a path the old Node relay served but this Worker
does not answers 404 without leaving the isolate. Same empty result, none of
the waiting.

There are two copies of the relay helper — `server/_shared/relay.ts` for the
server handlers, `api/_relay.js` for `/api/opensky`, `/api/telegram-feed`,
`/api/oref-alerts`, `/api/polymarket` and `/api/rss-proxy`. Fixing the first
and not the second is what left these two on 522 after the first pass. Both
are covered by `tests/worker/api-relay-override.test.mts` and
`tests/worker/maritime-route.test.mts`.

## The other 11, decided

The remaining 11 have no handler anywhere in the repo. Each was traced back
to what reads it. None needs a Worker route; one was a real defect, in a
registry rather than in a route table.

| Path | Reading |
|---|---|
| `/api/hls-proxy` | Tauri sidecar. Called at `http://127.0.0.1:${getLocalApiPort()}`, never at this origin. |
| `/api/youtube-embed` | Tauri sidecar, same call shape. |
| `/api/service-status` | The sidecar readiness poll in `waitForSidecarReady()`. Desktop only. |
| `/api/local-debug-toggle` | `isLocalOnlyApiTarget()` blocks every `/api/local-*` path from cloud fallback on purpose — these can carry local secrets. |
| `/api/local-traffic-log` | Same rule. |
| `/api/llm-health` | A real browser fetch. `LlmStatusIndicator` reads 404 as "no sidecar", hides itself and destroys the poller. The 404 is the answer it wants. |
| `/api/register-interest` | A prefix in the key-free allowlist. The route that runs is `/api/leads/v1/register-interest`, and that one is registered. |
| `/api/wingbits` | Survives only in a comment. `/api/military/v1/get-wingbits-status` replaced it. |
| `/api/v1/rss-outbound-feed` | Not ours — part of a channelnewsasia.com feed URL. Grep false positive. |
| `/api/unstable/mcp-server/mcp` | Not ours — part of `https://mcp.datadoghq.com/…`. Grep false positive. |
| `/api/risk-scores` | The one real finding. See below. |

### /api/risk-scores was a stale registry entry

`DESKTOP_PARITY_FEATURES` in `src/services/desktop-readiness.ts` named
`/api/risk-scores` and a handler file `api/risk-scores.js`. That file does
not exist and has not for some time. `src/services/cached-risk-scores.ts`
calls `IntelligenceServiceClient`, which reaches
`/api/intelligence/v1/get-risk-scores` — routed, and answering.

Nothing checked the registry, so the readiness report kept reporting on a
file that was gone. `tests/desktop-readiness-registry.test.mts` now asserts
that every path the registry names is on disk and every route it names
appears in a route table, so the next stale row fails the suite instead of
sitting there.

That test reads the generated `src/generated/server/**/*_server.ts` tables
plus `worker/routes/plain-api.ts`. Not `server/gateway.ts` — its `/api/…`
keys are a cache-policy map, and a live route can be missing from it:
`/api/military/v1/get-aircraft-details-batch` is, while its non-batch
sibling carries `'static'`.

## Reproducing

`git grep` for the path list, then probe. Nothing caches the result, so a
re-run after a port batch shows what moved. A route change reaches production
only when someone runs `cf-deploy.sh deploy` from the repo root — neither
`deploy-gate.yml` nor `deploy-worker.yml` publishes this Worker.
