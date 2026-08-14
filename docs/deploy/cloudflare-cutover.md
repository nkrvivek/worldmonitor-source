# Cloudflare deploy — worldmonitor.sibt.ai (Task 6)

Deployed 2026-08-02, ~10:45 PM PT (05:45Z). This is a Worker on a hostname we
own, and as of 2026-08-04 it is the permanent home — the `worldmonitor.app`
cutover is off the table, not merely blocked. See "What this does not do"
below.

## Live URLs

- Custom domain: `https://worldmonitor.sibt.ai`
- `workers.dev` fallback: `https://worldmonitor-web.nkrvivek.workers.dev`

Both answer today. The `workers.dev` URL is the fallback if the custom
domain misbehaves — keep it on (see the `workers_dev` note below).

**The API surface is moving over one route family at a time.** Four answer
from the Worker itself today: the market gateway, the maritime gateway,
`/api/bootstrap` (ported 2026-08-04), and `/wm/session`. Everything else
falls through to `UPSTREAM_API_ORIGIN`, which names a hostname —
`vercel-origin.worldmonitor.app` — that does not exist in DNS (confirmed by
`dig`: `NOERROR`, zero answers), so those paths return 404. Confirmed live:
`curl -sI https://worldmonitor.sibt.ai/api/health` → `404`, while
`/api/bootstrap?tier=slow&public=1` → `200` with all 41 keys filled.

`/api/bootstrap` mattered more than its share of the surface. Ten-plus
modules under `src/` read it and nothing else, so while it 404ed the shell
rendered and every panel stayed empty. Porting it was a call, not a rewrite:
`api/bootstrap.js` already exports a web-standard `(Request, ctx) => Response`
handler and reads config from `process.env`, which `nodejs_compat` fills from
vars and secrets. Its R2 shadow probe is the one Vercel-shaped path left
inside, and it stays dormant here — that code needs `VERCEL_ENV=production`,
and no such var exists on this Worker.

## Account and config

- Cloudflare account: **Nkrvivek@gmail.com's Account** (the only one the
  deploy token can see).
- Zone: `sibt.ai`. It also serves `dossier.sibt.ai` (Worker `sibt-dossier`).
  This deploy added one new subdomain and touched nothing else on the zone —
  confirmed `dossier.sibt.ai` still returns 200 after every deploy in this
  task, including the rollback test (see "Rollback" below).
- Worker script name: `worldmonitor-web`. The task brief expected the name
  `worldmonitor-spa`, based on a scan of the account before this task's
  `wrangler.jsonc` existed. The name in the committed config is
  `worldmonitor-web`; that's what deployed, and no rename was made — renaming
  wasn't in scope and the name is Task 1-4's decision, not this task's.
- `UPSTREAM_API_ORIGIN`: `https://vercel-origin.worldmonitor.app`. Set in
  an earlier task; nothing about it changed here. **This hostname does not
  exist in DNS today** — `dig vercel-origin.worldmonitor.app` returns
  `NOERROR` with zero answers, not even NXDOMAIN, meaning no A/AAAA record
  was ever created for it. Every `/api/*` request the Worker proxies
  through this origin fails to connect and the Worker returns 404, which
  is what `curl -sI https://worldmonitor.sibt.ai/api/health` shows. What
  this hostname should point at is a later plan's decision, not this
  task's.

## Deploy to the right account, or you deploy to nobody

Every `wrangler` command here needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` exported from
`/Users/Vivek/Development/autopilot-experiment/.env`. That token belongs to
the **nkrvivek@gmail.com** account, which owns the `sibt.ai` zone and the
`worldmonitor-web` script behind `worldmonitor.sibt.ai`.

A bare `npx wrangler deploy` does not fail. It falls back to the OAuth login
in `~/.wrangler`, which is a **different account** (vivek@adalma.ai), and
publishes a second, unrelated `worldmonitor-web` there. Signs you have done
this, all seen on 2026-08-03:

- The deploy reports success but ends with `Can't infer zone from route,
  please specify zone for "worldmonitor.sibt.ai" [code: 10082]` — that
  account has no `sibt.ai` zone.
- The printed URL is `worldmonitor-web.vivek-3b5.workers.dev`, not
  `worldmonitor-web.nkrvivek.workers.dev`.
- `worldmonitor.sibt.ai` keeps serving the previous build, so new routes
  404 there while the same paths work on the `workers.dev` URL you were
  just given.

`npx wrangler whoami` prints the account a bare command would use. Fixing it
is a redeploy with the two variables exported; the stray script in the other
account should then be deleted (`wrangler delete --name worldmonitor-web`,
run with those variables unset so it targets that account).

## What was done, in order

**Step 1 — preconditions.** `npm run test:worker`: 78 of 78 pass.
`WORKERS_CI=1 npm run build` produced `dist/`. Local parity, following
Task 5's method (`wrangler dev` on `:8787`, `UPSTREAM_API_ORIGIN` overridden
to `https://www.worldmonitor.app` since the real origin has no routable
stand-in): 6 of 79 URLs match, zero status-code mismatches — the same
result Task 5 recorded.

**Step 2 — deploy without the custom domain.** `npx wrangler deploy`
published the Worker to `https://worldmonitor-web.nkrvivek.workers.dev`
only. It served 200 on `/` right away; `/dashboard` flickered between 200
and 404 for about 15 seconds (edge propagation across colos right after a
fresh deploy), then settled at a steady 200. Not a routing bug — confirmed
by polling until three consecutive checks agreed.

**Step 3 — attach the custom domain.** Added to `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "worldmonitor.sibt.ai", "custom_domain": true }
]
```

Redeployed. **This succeeded** — Cloudflare created the DNS record and
issued the certificate without a permissions error, despite the brief's
expectation that the token's DNS scope would block it. `curl -sI
https://worldmonitor.sibt.ai/` returned 200 within the same deploy.

One side effect, caught by wrangler's own warning: adding a `routes` entry
silently disables `workers_dev` unless the config says otherwise. The
`workers.dev` URL 404'd right after this deploy. Fixed by adding
`"workers_dev": true` to `wrangler.jsonc` explicitly and deploying a third
time — both URLs answer now, as the brief requires.

**Step 4 — parity against the deployed Worker.**
`PARITY_WORKER_ORIGIN=https://worldmonitor.sibt.ai npm run parity:routing`:
6 of 79 match, zero status-code mismatches. The mismatch list is byte-for-byte
identical to the local run in Step 1 — the deployed edge behaves exactly
like local `wrangler dev` for every URL in the corpus. Status-code parity on
the four groups that matter:

- `/countries/*` — 0 status-code mismatches
- `/chokepoints/*` — 0 status-code mismatches
- `/reference/changelog` — 0 status-code mismatches
- `/pro` — 0 status-code mismatches

Remaining mismatches are three categories, two carried over from the Task 5
report and one specific to what's actually live here:

- Implicit `Access-Control-Allow-Origin` / `Cache-Control` CDN defaults —
  out of scope, same as Task 5.
- CSP hash drift against whatever commit production is running — out of
  scope, same as Task 5.
- `/api/*` — mismatches for a different reason on each side, and the two
  should not be conflated. Locally (Step 1), the parity run substitutes
  `https://www.worldmonitor.app` for `UPSTREAM_API_ORIGIN` since the real
  origin has no routable stand-in, and Vercel's WAF blocks that substituted
  origin — a local-run artifact, unrelated to this deploy. Against the
  *deployed* Worker here, the cause is different and more basic: the
  committed `UPSTREAM_API_ORIGIN`, `vercel-origin.worldmonitor.app`, does
  not resolve in DNS at all (confirmed by `dig`), so every `/api/*` request
  fails to connect and 404s. See "This deployment serves the SPA shell
  only" above.

**Step 5 — brand-variant check. The brief's literal method does not work,
and that's worth stating plainly rather than papering over.**

The brief's command was:

```bash
curl -sI -H "Host: happy.worldmonitor.app" \
  https://worldmonitor-web.nkrvivek.workers.dev/dashboard | head -3
```

Run as written, this returns a bare `403 Forbidden` from Cloudflare itself,
before the request ever reaches the Worker — against both the `workers.dev`
URL and the custom domain, and against HTTP/1.1 as well as HTTP/2. Cloudflare
rejects a request whose Host header names a hostname that doesn't match the
zone actually being connected to; this is a platform anti-spoofing check, not
a Worker bug. The same command against real production
(`www.worldmonitor.app`) gets the identical 403 — confirmed by hand. It is
not specific to this deploy.

Node's `fetch()` (what `scripts/routing-parity.mjs` uses) doesn't 403 the
same request, but it also doesn't change anything: it silently drops the
`Host` header override and connects using the URL's own hostname. Confirmed
by inspecting the response body's `<title>` — spoofing `Host:
happy.worldmonitor.app` against either the deployed Worker or real Vercel
production returns the generic `www` title, never `Happy Monitor`'s. So the
parity harness's five brand-host corpus entries (`tech`, `finance`,
`commodity`, `happy`, `energy` × `/dashboard`) have never actually exercised
host-conditional routing on either side, in this task or Task 5 — a
pre-existing harness limitation, not something this task introduced or can
fix from here.

`wrangler dev` has a matching but separate problem: it does not rewrite
`request.url`'s host from a spoofed `Host` header, so a local curl test with
`-H "Host: ..."` never even builds a differently-hosted `URL` for the Worker
to read (`worker/index.ts` reads `url.host`, not the raw header). A real
edge request from a real `happy.worldmonitor.app` visitor is not affected —
there, the incoming Host header and the connection's URL host genuinely
agree — but that path can't be reproduced without owning DNS for that
hostname, which this task does not.

What actually verifies the brand-variant rewrite logic:
`tests/worker/resolve.test.mts:85-89`, `'each variant host gets its own
dashboard'` — it constructs `Request` objects directly with each brand host
and asserts `/dashboard` resolves to `/dashboard-${variant}.html` for `tech`,
`finance`, `commodity`, `happy`, and `energy`. That test is part of the 78
passing in Step 1. It sidesteps the HTTP-layer Host/URL mismatch entirely,
which is exactly why it's the reliable check here and the curl-based method
in the brief isn't.

What the brief's fallback claim *can* be checked directly, and was: a
request with no Host override, against either live URL, falls back to the
`www` dashboard at 200 — it does not error.

```
curl -sI https://worldmonitor.sibt.ai/dashboard          → 200
curl -sI https://worldmonitor-web.nkrvivek.workers.dev/dashboard → 200
```

## Rollback

Nothing on `worldmonitor.sibt.ai` carries production traffic. Removing it
affects nobody. `dossier.sibt.ai` and its Worker (`sibt-dossier`) are a
separate record and a separate script — neither is touched by any of the
following, and both were checked and confirmed unaffected after the test
below.

**This section was tested live, not just written.** The earlier version of
this doc said that removing the `routes` block from `wrangler.jsonc` and
redeploying "removes the DNS record Cloudflare created." That was wrong.
Here is what actually happens:

1. Removed the `routes` block from `wrangler.jsonc`.
2. `npx wrangler deploy` (with `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` exported, same as the deploy above). **No
   interactive prompt.** It runs the same as any other deploy — nothing to
   answer, nothing that would hang a non-interactive run. Wrangler's
   "Deployed … triggers" output stopped listing `worldmonitor.sibt.ai`
   after this — only the `workers.dev` line remained.
3. Checked what that actually changed:
   - `dig +short worldmonitor.sibt.ai` — **still returned the same two A
     records**, immediately after the deploy and again against
     Cloudflare's own authoritative nameserver
     (`dig @dayana.ns.cloudflare.com worldmonitor.sibt.ai +short`) and
     against `1.1.1.1`, to rule out a cached answer. All three agreed: the
     record did not go away.
   - `curl -sI https://worldmonitor.sibt.ai/` — **still 200.**
   - `GET /accounts/{account_id}/workers/domains` (the Workers Domains API,
     readable with this token) — the Custom Domain object for
     `worldmonitor.sibt.ai`, bound to `worldmonitor-web`, zone `sibt.ai`,
     was **still present and `"enabled": true`**, cert intact, alongside
     the three other domains on the account (`dossier.sibt.ai`,
     `nkrvivek.com`, `www.nkrvivek.com` — all unaffected).

   **So: removing the `routes` entry from `wrangler.jsonc` and redeploying
   does not detach the Custom Domain.** The DNS record and the Custom
   Domain object are a separate Cloudflare-side resource that a plain
   config omission doesn't reconcile away. wrangler will stop *listing* the
   route, but the binding keeps serving traffic regardless of what's in
   `wrangler.jsonc`.
4. Restored the `routes` block and redeployed once more. `curl -sI
   https://worldmonitor.sibt.ai/` → 200 again, as expected — the hostname
   never actually stopped serving at any point in this test, so there was
   nothing to recover from.

**To actually remove the custom domain**, `wrangler.jsonc` edits are not
enough. Use one of:

- Dashboard: Workers & Pages → `worldmonitor-web` → Settings → Domains &
  Routes → remove `worldmonitor.sibt.ai`. (Suggested by the brief; not
  performed here — deleting a live, working binding wasn't asked for and
  nothing is broken.)
- `DELETE /accounts/{account_id}/workers/domains/{domain_id}` on the same
  Workers Domains API used to confirm the finding above. Not run here for
  the same reason.

Neither of these has been tested in this task. If a future rollback needs
one of them, test it the same way this section was tested, before trusting
the result.

**Delete the Worker entirely:**

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
npx wrangler delete
```

Or from the dashboard: Workers & Pages → `worldmonitor-web` → Settings →
Delete. Not tested in this task — the reasoning above (config removal
leaves the Custom Domain in place) means `wrangler delete` should be
verified the same way before anyone relies on it removing the DNS record,
rather than assumed.

## What this does not do

- Most of `/api/*` does not work on this deployment. `UPSTREAM_API_ORIGIN`
  names a hostname that doesn't exist in DNS (see "Account and config"
  above), so any path that falls through to the proxy gets a 404. Four
  route families answer from the Worker itself and do work: the market
  gateway, the maritime gateway, `/api/bootstrap`, and `/wm/session`. The
  other 33 gateway domains still fall through.
- `worldmonitor.app` still serves from Vercel, through a Cloudflare zone we
  don't own (see the plan's roadmap, "The zone is not in our account"). No
  production DNS moved in this task.
- Task 7, the `worldmonitor.app` DNS cutover, will not happen.
  `worldmonitor.sibt.ai` is the permanent home (user decision, 2026-08-04:
  "yes worldmonitor.sibt.ai is the permanent home"). The zone we don't own
  is no longer a blocker to route around — it is a hostname we no longer
  want. Anything the roadmap made conditional on that cutover is now
  conditional on nothing.
- `vercel.json` stays in the repo and stays authoritative. The Vercel
  project stays deployable for the whole of Plan 4a. Neither is removed
  until Plan 4d.

---

# Seed crons — Railway to Cloudflare (plan 2026-08-03-railway-seeds, Task 4)

Cut over 2026-08-03, ~10:14 PM PT (05:14Z). Version ID
`755094af-fcbc-4a3d-ab19-9ea9737d87d2`. The six Cron Triggers below now run
the eight seed scripts that eight Railway services used to run.

## What runs where

Each trigger calls `scheduled()` in `worker/entry.ts`, which starts one
Container instance per script path. Instance-per-path keeps two scripts
sharing a cron expression out of each other's way.

| Cron | Scripts |
|---|---|
| `*/5 * * * *` | `seed-bundle-derived-signals.mjs`, `seed-bundle-market-backup.mjs` |
| `*/15 * * * *` | `seed-conflict-intel.mjs`, `seed-gdelt-bulk-materializer.mjs` |
| `0 */1 * * *` | `seed-bundle-portwatch.mjs` |
| `0 */6 * * *` | `seed-supply-chain-trade.mjs` |
| `0 */12 * * *` | `seed-bundle-portwatch-port-activity.mjs` |
| `0 6 1 * *` | `seed-comtrade-bilateral-hs4.mjs` |

The container image is built by `.github/workflows/seed-container-image.yml`
and pushed to `registry.cloudflare.com/…/worldmonitor-seeds` under the tag
`scripts/seed-image-tag.sh` derives from the seed sources. `wrangler deploy`
reads that pre-built tag, so no laptop needs a Docker daemon.

## A container gets no environment unless you hand it one

The first deploy started seven container instances and wrote nothing. The
cause was not configuration: `@cloudflare/containers` defaults `envVars` to
`{}`, and the `start()` call passed only `entrypoint` and `enableInternet`,
so every seed read an empty `process.env` and could not reach Upstash.

`worker/seeds/env.ts` fixes it. It holds an allowlist of variable names and
`worker/entry.ts` passes `envVars: seedEnvVars(env)`. The list is an
allowlist rather than a spread of `env` — `WM_SESSION_SECRET` signs sessions
and no seed reads it. Blank and non-string values are dropped, because
`_bundle-runner.mjs` counts a blank string as missing and would skip the
section anyway; forwarding `""` would satisfy the presence check with
nothing behind it.

Six secrets are on the Worker. Five reach the containers:
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `FINNHUB_API_KEY`,
`CONVEX_SITE_URL`, `RELAY_AUTH_HEADER`. Four more names sit on the list
unset — `RELAY_SHARED_SECRET`, `JAPAN_MOD_PROXY_URL`, `PROXY_URL`,
`COMTRADE_API_KEYS` — so setting one later needs no code change.

## What the cutover proved

Measured after the fix deployed, against the Upstash database the Worker's
secrets name:

- Both `*/5` bundles ran and wrote. `seed-meta:market:crypto`,
  `:hyperliquid-flow`, `:stablecoins`, `:etf-flows`, `:gulf-quotes`,
  `:token-panels`, `:gold-etf-flows`, `:gold-cb-reserves`,
  `:intelligence:sec-cik-map` (10,432 records), `:sec-8k-stream`,
  `:intelligence:china-decision-signals`, `:gdelt-intel`,
  `:regional-snapshots` all carry a `fetchedAt` from that run.
- The `*/15` cron wrote too: `gdelt:intel:tone:*` and `vol:*` across six
  topics, plus 26 `seed-meta:conflict:humanitarian:v1:*` country records.
- Database size went from 0 keys to 133.

A Cron Trigger fires, `getContainer(...).start()` reaches a running
instance, and a seed writes to Upstash from inside Cloudflare's network.
That was the whole open question for this task.

## Two sections still write nothing, for a reason outside this port

`Correlation` and `Cross-Source-Signals` in the `*/5` derived-signals bundle
produce zero records. Neither is a Cloudflare problem — running both scripts
from a laptop against the same database fails identically:

```
[Correlation] inputs: flights=0 protests=0 outages=0 quakes=0 markets=0 news=0
FAILURE: declareRecords returned 0 and last-good preservation failed

[Cross-Source-Signals] Found 3/22 source keys populated
Extracted 0 raw signals
```

Both derive from keys other seeds write: `military:flights:v1`,
`unrest:events:v1`, `infra:outages:v1`, `seismology:earthquakes:v1`,
`market:stocks-bootstrap:v1`, `market:commodities-bootstrap:v1`,
`news:insights:v1`, and twelve more. Every one of those comes from a service
in `scripts/railway-services.json` that carries **no `cronSchedule`** —
`seed-market-quotes`, `seed-commodity-quotes`, `seed-insights` and their
siblings. Nine of the 41 registry entries have a schedule; 32 do not, and
what triggers those 32 is still unknown. Until that is answered, the two
derived sections have nothing to derive from.

`China-Corporate-Disclosures` and `Cross-Strait-Activity` skip for a
simpler reason: their `requiredEnv` (`RELAY_SHARED_SECRET`, and
`JAPAN_MOD_PROXY_URL || PROXY_URL`) is unset. Set the secret and they run.

## Turning Railway off

The eight seed services these six triggers replace can be turned off:
`seed-bundle-derived-signals`, `seed-bundle-market-backup`,
`seed-conflict-intel`, `seed-gdelt-intel`, `seed-bundle-portwatch`,
`seed-supply-chain-trade`, `seed-bundle-portwatch-port-activity`,
`seed-comtrade-bilateral-hs4`.

Leave everything else alone. The other 31 entries in
`scripts/railway-services.json` — `relay`, `digest-notifications`,
`publish-bootstrap-tiers`, and the rest, none of which carry a schedule — are
untouched by this task and still run where they always did.
Turning off the ones the two derived sections depend on would take working
data away, not idle services.

---

# AIS relay — Node process to Durable Object (plan 2026-08-03-p4f, Task 9)

**Status: deployed and carrying live data, not cut over.** The code is merged
to `main` and live on `worldmonitor-web` (version
`95a7550a-e248-41f3-9774-73c9aa12e3e8`, deployed 2026-08-04). Both secrets are
set, the Durable Object holds an open connection to AISStream, and
`/ais/snapshot` returns real vessels. Nothing has been repointed, so
`scripts/ais-relay.cjs` still serves production.

## What exists now

`AisRelayDO` (`worker/ais/relay-do.ts`) holds one outbound WebSocket to
stream.aisstream.io, keeps vessel state in memory, and answers `/snapshot`.
A 30-second alarm re-arms it: Durable Objects are evicted after 70-140s idle,
so the alarm is what keeps the connection from dying quietly. The reconnect
backoff lives in DO storage, not memory, so an eviction does not reset it into
a tight retry loop against an upstream that is already down.

`/ais/snapshot` on the Worker (`worker/routes/ais-snapshot.ts`) checks the
shared secret, then forwards to the DO, carrying the query string so the
`bbox` and `tankers` filters survive.

## Secrets

**`RELAY_SHARED_SECRET` — done.** Minted fresh (`openssl rand -hex 32`), set on
the Worker, and written to the gitignored `.env.local` so callers on this
machine match. Minting was safe because the route is new: nothing was calling
`/ais/snapshot` before this deploy, so there was no other end to keep in step.

**`AISSTREAM_API_KEY` — done.** This one could not be minted; it is an account
key from aisstream.io, supplied by hand and set with:

```bash
cd /Users/Vivek/Development/worldmonitor
/Users/Vivek/Development/trade-refresh/scripts/cf-deploy.sh secret put AISSTREAM_API_KEY
```

Paste at the prompt. Never as an argument — shell history keeps those.

Setting it in `.env.local` breaks the test suite unless the test config
overrides it. Wrangler loads `.env.local` into the vitest-pool-workers
environment, so a real key makes `connectUpstream()` dial stream.aisstream.io
during unit tests: three tests fail, two of them by timeout, on a machine where
nothing is wrong. `vitest.ais-relay.config.mts` now forces
`AISSTREAM_API_KEY: ''` in its miniflare bindings. Leave that line alone.

## Deploy

Always through `/Users/Vivek/Development/trade-refresh/scripts/cf-deploy.sh` —
never bare `npx wrangler deploy`, which lands on whatever account a stale OAuth
session points at. Migration `v3` applied `AisRelayDO` on the 2026-08-04
deploy; `env.AIS_RELAY (AisRelayDO)` shows in the binding list.

Smoke test, run 2026-08-04:

```bash
export RK="$(grep '^RELAY_SHARED_SECRET=' .env.local | cut -d= -f2-)"
curl -s -o /dev/null -w "%{http_code}\n" https://worldmonitor.sibt.ai/ais/snapshot
curl -s -H "x-relay-key: $RK" https://worldmonitor.sibt.ai/ais/snapshot
```

No key returned `403`. With the key, thirty seconds apart:

```
vessels 6690 messages 9357 dropped 0 density 200 disruptions 5
vessels 7975 messages 11847 dropped 0 density 200 disruptions 6
```

## Two bugs the smoke test found

Both passed the unit suite and a code review. Reading the counters is what
caught them, so read them, not just `connected`.

**The subscribe frame never went out.** The port sent it from an `open`
listener, copying `scripts/ais-relay.cjs`, which uses the Node `ws` library
where `open` does fire. A client socket taken from `response.webSocket` in a
Worker is already connected — the 101 response is the handshake — so no `open`
event ever fires and the listener never ran. AISStream sends nothing until it
is subscribed, so the relay sat at `connected:true`, `messages:0`,
`droppedMessages:0`. Now the frame goes out immediately after `accept()`.

**Every message was dropped.** With the subscription fixed, messages arrived
and all of them landed in the drop counter: 5,276 received, 5,276 dropped, 0
vessels. AISStream sends its JSON over binary frames, which since compatibility
date 2026-03-17 arrive as `Blob` — and a `Blob` can only be read
asynchronously, which a WebSocket message listener cannot do. Setting
`ws.binaryType = 'arraybuffer'` before `accept()` brings back synchronous
bytes, and the handler decodes them as UTF-8.

Both have tests in `tests/ais-relay/relay-do.test.mts`, each of which fails
when its fix is reverted.

Only now is it safe to move `WS_RELAY_URL`.

## WS_RELAY_URL — done, and what it does not do

Set to `https://worldmonitor.sibt.ai` in `wrangler.jsonc` `vars` and deployed
2026-08-04 (version `6e74350f-2097-4826-8512-bb8105ce4b1d`). It was not
pointing at the old Node relay beforehand — it was not set at all, on the
Worker or anywhere else, so `getRelayBaseUrl()` returned null and every
relay-backed handler skipped its call. That is why those panels were empty.

`WS_RELAY_URL` is the base URL for the whole relay, not for AIS. The old Node
process served about twenty route families — `/telegram`, `/oref`, `/opensky`,
`/google-flights`, `/yahoo-chart`, `/polymarket`, `/rss`, `/ucdp-events`,
`/worldbank`, `/wingbits/track` and more. The port covers `/ais/snapshot` and
nothing else, so the rest 404 on this Worker. Their handlers treat a non-ok
relay response as no data, so they answer empty either way.

## The consumer path — ported 2026-08-04

`/api/maritime/v1/get-vessel-snapshot` used to 404: the maritime gateway was one
of the unported `/api/*` routes, so `worker/index.ts` proxied it to
`UPSTREAM_API_ORIGIN`, which nothing serves. `worker/routes/maritime.ts` now
ports it the way `worker/routes/market.ts` ports market. Both maritime RPCs move
together, so there is no staying-behind set.

Deployed version `c70fbd5e-d604-4fcf-beb0-43cb781d85fe`. The endpoint needs a
`wm-session` cookie like every other gateway route — without one it answers 401,
not 404, which is easy to misread as still-broken:

```bash
curl -s -c /tmp/wm.txt -o /dev/null -X POST https://worldmonitor.sibt.ai/api/wm-session \
  -H 'content-type: application/json' -d '{}'
curl -s -b /tmp/wm.txt -X POST https://worldmonitor.sibt.ai/api/maritime/v1/get-vessel-snapshot \
  -H 'content-type: application/json' -d '{}'
```

Live answer: `dataAvailable true`, 163 density zones, 3 disruptions, status
`connected true, vessels 1613`.

**A Worker cannot fetch its own hostname.** The first deploy of the port
returned an empty snapshot, and the handler's own log said why:
`relay https://worldmonitor.sibt.ai/ais/snapshot returned HTTP 522` — a
connection timeout, while the Durable Object behind that path held 8,000
vessels. `WS_RELAY_URL` names this Worker, so the subrequest never re-entered;
it went out and died. `server/_shared/relay.ts` now takes a pluggable fetcher,
and the maritime route installs one that calls the Durable Object directly and
leaves every other URL on the network
(`relayFetchViaDurableObject`, guarded in `tests/worker/maritime-route.test.mts`).

That also removes the shared secret from this path: a handler already inside
the Worker has no secret to present, and `fetchAisSnapshot()` is the door it
uses instead of `handleAisSnapshot()`.

Three returns in `fetchVesselSnapshotFromRelay` used to be silent. They now log
their reason, because each one ends as an empty snapshot at the caller and an
empty ocean reads exactly like a quiet one.

Right after that deploy, two probes still answered `dataAvailable false` and
`wrangler tail` showed no reason for either. Old isolates serving the previous
code fit the evidence: they would 522 on the self-fetch, they drain over the
rollout rather than stopping at once, and `wrangler tail` samples events away
under load, so a log line can exist and never reach the terminal. That is the
likely reading, not a proven one — the isolate had already been replaced by the
time anyone could look. Every silent path in the handler now logs, so a repeat
would leave a trace. It has not repeated: five probes across the base, tanker
and bbox cache keys all answered `dataAvailable true` with 200 density zones.

The front end reads the same value as `VITE_WS_RELAY_URL` at build time.
Whichever side sets it must send header `x-relay-key`, matching the Worker's
`vars.RELAY_AUTH_HEADER`.

An earlier note here said `RELAY_AUTH_HEADER` also existed as a Worker secret
and should be dropped. It does not. `wrangler secret list` shows six secrets
and that name is not among them, so the `wrangler.jsonc` var is the only
source. Nothing to remove.

## Rollback

One environment variable, and only after the repoint happens — until then
there is nothing to roll back. Point `WS_RELAY_URL` back at the Node relay.
`scripts/ais-relay.cjs` is deliberately still in the tree and still able to
serve. Nothing on the Cloudflare side needs reverting — the Worker and the DO
can stay live and simply stop receiving traffic.

## Two things this does not close

`seedChokepointTransits()` writes `supply_chain:chokepoint_transits:v1`, which
`api/health.js` reads for its freshness check. The Durable Object has no
equivalent — it is a periodic job, not part of a request/response path, and it
needs its own plan.

So `scripts/ais-relay.cjs` cannot be deleted yet. Deleting it also deletes
that seeder's only implementation. Delete it once the Durable Object has run
in production long enough to trust as the sole source **and** the seeder has
a home.
