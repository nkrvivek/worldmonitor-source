# WorldMonitor signal triage — 2026-08-29

Verified findings from a full audit of why ~20 datasets are EMPTY/STALE. Every
claim here was checked against code, live API probes, or GitHub run history.
Items marked OPEN are unresolved and need a decision.

## TL;DR

The dead datasets are **not** mostly a code problem. They split into:

| Cause | Datasets | Nature |
|---|---|---|
| `consumer-prices-core` not deployed anywhere | ~13 | Infrastructure (see below) |
| Seeders addressed to decommissioned Railway | 5-6 | Port to current platform |
| Genuinely missing third-party API keys | 4 | Signups |
| Deliberately dormant (free-tier cost choice) | 3 | Leave alone |

## CI FAILURES: what the GitHub notification emails were actually reporting

Checked 2026-08-30. The failure emails go to **nkrvivek@gmail.com**, not
bnayanan@gmail.com (uid 0 has zero). ~50 recent ones break down as:

| Count | Workflow | Verdict |
|---|---|---|
| 11 | worldmonitor Seed Freshness Monitor | NOT broken - drift detector doing its job |
| 10 | worldmonitor Test | mine, fixed |
| 10 | worldmonitor Build seed container image | stale image pin, fixed |
| 2 | worldmonitor Lint Code | markdown MD032, fixed |
| 2 | autopilot Integration Tests | order-path gate, already fixed in 0a5ec17 |
| 2 | autopilot Deploy hackathon worker | 503 on post-deploy container probe |

### The big one: Seed Freshness Monitor was reporting our own success

It is a drift detector that exits 1 when live health stops matching
`scripts/seed-freshness-baseline.json`. It had been failing because the 13
consumer-prices rows moved from EMPTY records=0 to STALE_SEED records=1 - i.e.
because consumer-prices-core started working. Their acknowledgement text still
said "Nothing runs this seed... Credential-blocked", which had become false.

Reconciling those 13 dropped blocking problems from **14 to 3**. The remaining
three (crossStraitActivityTaiwanMnd, newsInsights, theaterPosture) are
pre-existing and unrelated to this work.

**Finding worth its own line: the primary consumer-prices slice is the dark
one.** api/health.js checks `consumer-prices:*:ae`, matching this dashboard's
Gulf focus, while cpc-jobs scrapes only kroger_us and walmart_us. maxStaleMin
1500 is correctly sized for the daily cadence; the COUNTRY is the mismatch.
Five AE adapters already ship in configs/retailers/. This was previously
mis-framed as "widen to all 19 retailers" - the sharper statement is that the
slice the app reads by default has no data, and enabling AE would light up six
aggregate rows.

### Two CI traps worth remembering

1. **`seed-image-tag.sh` reads the git INDEX.** Running the image-tag test
   before staging computes the tag for the previous content, which matches the
   stale pin and passes. The test docstring warns about this in capitals; I hit
   it anyway, twice. Stage, then run.
2. **The baseline JSON is inside the seed image build context.** A data-only
   edit to `scripts/seed-freshness-baseline.json` moves the image hash and
   requires a re-pin, exactly like adding a seed script does.

### A near-miss worth recording

All four trading books (live, paper, hackathon, wheel) use cron `2-6`, and the
comments read "Mon-Fri". Under standard cron that would be Tue-Sat, i.e. a book
skipping Monday and firing on a closed Saturday, and it looked like a real bug.
It is not. **Cloudflare follows Quartz: 1 = Sunday to 7 = Saturday**, and the
Cloudflare docs list `10 7 * * 2-6` as their own example of "on weekdays". The
configs and their comments are correct. "Fixing" this would have shifted every
book to Sunday-Thursday and broken live trading.

---

## REGRESSION 2026-08-31: consumer-prices went EMPTY — cron runs scrape only

The 13 consumerPrices rows moved from STALE_SEED records=1 (2026-08-30) to
**EMPTY records=0**. The data verified flowing on Aug 29 is gone.

**Not an outage.** Railway is healthy: Postgres Online, cpc-api Online and
answering `/health` 200 with `postgres: ok`, and cpc-jobs reports "Last run
succeeded, next in 3 hours". The last execution was 2026-08-30 09:01 UTC, ran
5m 6s, and its logs show a clean scrape: `Run ... finished: completed (12/12
pages, rejected=3)` with real prices parsed (Kroger cheddar $7.99, yogurt $2.99).

**CORRECTION 2026-08-31: the root cause below is WRONG. Do not act on it.**

I read the Custom Start Command out of an accessibility snapshot that TRUNCATED
the field, saw `node dist/jobs/scrape.js`, and concluded the pipeline never
reached publish. The actual value is:

    node dist/jobs/scrape.js kroger_us && node dist/jobs/scrape.js walmart_us && node dist/jobs/aggregate.js && node dist/jobs/publish.js

It does run aggregate and publish, with per-retailer arguments. I briefly typed
the "fix" over it, which would have dropped both retailer args; it was reverted
and verified intact after a page reload, and was never committed (no pending
deploy control appeared). No change was made to the service.

WHAT IS ACTUALLY KNOWN, and nothing beyond it:

- Upstash `consumer-prices:overview:us` and `:ae` are MISSING;
  `seed-meta:consumer-prices:overview:us` is PRESENT (129b). Data keys carry 26h,
  seed-meta carries 7d, so metadata outliving data is expected and is why this
  presents as EMPTY records=0.
- The last execution (2026-08-30 09:01 UTC, 5m06s) reports SUCCEEDED, and its
  visible log ends at `[scrape] Run ... finished: completed (12/12 pages,
  rejected=3)` for Kroger, with no Walmart/aggregate/publish output after it.
- The log panel may itself be truncated or lazy-loaded, so the absence of that
  output is NOT evidence the steps did not run. Having already been burned once
  by truncation on this exact service, treat it as unknown.

NEXT DIAGNOSTIC STEP: get the FULL execution log (scroll the panel to the true
end, or pull it via the Railway API with the `aside-cpc-automation` project token)
and look for `[aggregate]` and `[publish]` lines. If publish ran, compare the key
names it writes against the ones health reads. If it did not, find where the
chain stopped.

---

**Root cause: the cron runs the SCRAPE step only.** The pipeline is three
separate scripts (`package.json`): `jobs:scrape`, `jobs:aggregate`,
`jobs:publish`. Only `publish.ts` writes to Upstash. So:

- Postgres accumulates scraped rows (scrape writes there) — looks healthy
- Upstash never receives a snapshot (publish never runs) — data keys expire
- `seed-meta:consumer-prices:overview:us` SURVIVES because seed-meta carries a
  7-day TTL while the data keys carry 26h. That asymmetry is why this reads as
  "EMPTY records=0" rather than as a missing seeder, and why it took a day to
  surface.

Confirmed in Upstash: `consumer-prices:overview:us` and `:ae` both MISSING,
`seed-meta:consumer-prices:overview:us` PRESENT (129b).

**Fix — one field, Railway UI, cpc-jobs service → Settings → Custom Start
Command.** It must chain all three steps and must use the COMPILED output, not
the npm scripts: `tsc` emits `src/jobs/*.ts` to `dist/jobs/*.js`, and `tsx` is a
**devDependency pruned from the production image**, so `npm run jobs:publish`
cannot work in the container. This is the same trap the Dockerfile CMD hit
earlier (`node dist/db/migrate.js`, not `tsx`).

    node dist/jobs/scrape.js && node dist/jobs/aggregate.js && node dist/jobs/publish.js

There is no `railway.json`, `nixpacks.toml` or `Procfile` in the repo, so this
cannot currently be fixed in code — worth ADDING a `railway.json` with the
start command so the next person is not dependent on a UI field.

Note: the trial shows **"29 days or $4.96 left — upgrade to keep your services
online"**, which is a separate, approaching constraint.

---

## STATUS UPDATE 2026-08-30 (later): Railway-relay orphans, resolved and re-homed

Commits `a4055cf20` (sectors) and `14cfca6ee` (pizzint). Both verified with live
runs writing real data to Redis, not just tests.

### sectors -> FIXED, live (`scripts/seed-sector-summary.mjs`)

Ported from ais-relay.cjs:2367-2440 onto the container rail, scheduled on the
existing `11,41 * * * *` market tick beside seed-market-quotes and
seed-commodity-quotes (shared Finnhub/Yahoo rate budget). The valuation
machinery already lived in `scripts/_yahoo-sector-valuations.cjs`, so this was
a port, not a rewrite.

Verified live: **12/12 sectors, 12/12 valuations, state OK**, both
`market:sectors:v2` and the `market:quotes:v1:...` companion present.

Two things worth carrying forward:

- The relay only fell back to Yahoo on a TOTAL Finnhub wipeout. That
  all-or-nothing fallback is what let the documented double-failure publish
  nothing instead of a partial set. The port falls back on ANY shortfall.

- `api/health.js` classifies this row on sector-specific meta fields
  (`sectorRecordCount`, `valuationRecordCount`, `expectedValuationRecordCount`,
  `sourceState`) and `tests/health-classify.test.mjs` pins that behaviour. They
  are written via an `afterPublish` -> `freshnessMetaPatch` return; runSeed
  keeps ownership of fetchedAt/recordCount/sourceVersion through
  FRESHNESS_META_RESERVED_FIELDS. A plain runSeed call would have looked fine
  and left health unable to tell healthy from degraded.

### pizzint -> FIXED, live (`scripts/seed-pizzint.mjs`)

Upstream was never the problem: `pizzint.watch/api/dashboard-data` answers 200
(~42KB). Scheduled on the live `7,37 * * * *` expression beside seed-insights.

**Found a separate, older bug while porting.** The relay called
`/api/gdelt/batch` with `pairs` + `method` only, and upstream now requires a
date window:

    {"error":"Missing required query parameters: pairs, method, dateStart, dateEnd"}

That leg is caught and non-fatal, so it never surfaced anywhere. The relay was
silently publishing `tensionPairs: []` on every single run, and the panel showed
no tensions with no error logged. The port sends an explicit 90-day window.
Verified live: **gdelt:6 pairs** where the relay produced 0.

### socialVelocity + wsbTickers -> BLOCKED, Reddit API policy (external)

Both use the same Reddit fetch path. Measured 2026-08-30:

- Public JSON (`reddit.com/r/<sub>/hot.json`, no auth): **HTTP 403** even from a
  residential IP. The unauthenticated tier is simply gone.

- OAuth tier needs `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`. Both keys exist in
  `.env.local` but are EMPTY.

- Signed into Reddit (bnayanan@gmail.com via Google) and attempted to register a
  script app at old.reddit.com/prefs/apps. **Reddit's server refused it:**
  "In order to create an application or use our API you can read our full
  policies here: .../Responsible-Builder-Policy"

So new app creation is gated behind Reddit's Responsible Builder Policy. This
confirms the relay comment at ais-relay.cjs:5899 describing its own credentials
as "pre-policy app creds" — those were issued before the gate existed and cannot
be reissued the same way. Unblocking needs a human to go through Reddit's policy
registration, or a paid ScrapeCreators key (`SCRAPECREATORS_API_KEY`, the
preferred tier the code already supports).

### productCatalog -> BLOCKED, needs STRIPE_SECRET_KEY

`STRIPE_SECRET_KEY` is absent from `.env.local` (not empty — absent). The seed
reads live Stripe prices for `product-catalog:v3`. This is worldmonitor's OWN
Stripe account, so the key exists somewhere in the user's Stripe dashboard; it
was simply never provisioned to this environment.

### digestNotifications -> still unscheduled, by design

Not a relay orphan in the same sense. `worker/seeds/registry.ts` groups it with
`publish-bootstrap-tiers` and `relay` as jobs that each need "its own port"
rather than a slot on the shared seed container. Re-homing it is a Worker-route
change, not a registry line, so it was left alone rather than forced onto the
container rail.

---

## STATUS UPDATE 2026-08-30: Worker credentials wired, grocery-basket scheduled

Commit `ea870cacd`, deployed (Deploy worldmonitor-web green, 3m17s).

**Cloudflare Worker secrets added** (via dash.cloudflare.com, Nkrvivek@gmail.com
account `3e2617...` — note the wrangler CLI on this machine is authenticated as
**vivek@adalma.ai** (`3b5498...`) and therefore CANNOT write worldmonitor's
secrets; `wrangler secret put` silently appears to 200 then fails auth on read.
Use the dashboard, or `wrangler login` as nkrvivek first):

- `FIRECRAWL_API_KEY`
- `CONSUMER_PRICES_CORE_API_KEY`
- `CONSUMER_PRICES_CORE_BASE_URL`

**seed-grocery-basket is now SCHEDULED** — joined the existing Sunday price tick
(`0 10 * * SUN`) with seed-fuel-prices and seed-bigmac. Same CACHE_TTL (864000)
and maxStaleMin (10080), and it is a price series, so it reads honestly there and
adds no new cron expression. It was blocked only on Firecrawl.

**seed-consumer-prices stays OFF cron — important correction.** The registry
docstring previously listed it as merely credential-blocked. Its own header says
"Do NOT configure as a Railway cron": it writes 10-60 minute TTLs that stomp the
authoritative 26h TTLs written by consumer-prices-core's `publish.ts`. Running
both means whichever ran last wins. The Worker now holds its credentials purely
so the fallback can be run by hand with `--force` if publish.ts ever breaks.

Tests: 32 worker seed tests pass (incl. "reaches every scheduled script within a
month"), plus seed-services-registry, seed-freshness-workflow and
seed-freshness-monitor suites.

---

## STATUS UPDATE 2026-08-29 (late): consumer-prices-core is DEPLOYED AND RUNNING

Section 1 below described the blocker. It is now resolved. Deployment summary:

- **Platform: Railway** (not Supabase/Neon/CF). Project `consumer-prices-core`,
  id `d425cc33-8ba5-4fc4-9ba1-27214d4727b4`.

- **Postgres 18** service, 500 MB volume. All 10 migrations applied.
- **`cpc-api`** service: https://cpc-api-production.up.railway.app — `/health`
  returns `postgres: ok`; API-key auth verified (401 without key).

- **`cpc-jobs`** service: cron `0 9 * * *` UTC (2 AM PT) running
  `scrape kroger_us && scrape walmart_us && aggregate && publish`.
  Cron set via Railway GraphQL `serviceInstanceUpdate` (the CLI has no cron
  command; the API needs a browser-like User-Agent or Cloudflare returns 1010).

- **Dockerfile CHANGED** (uncommitted): `CMD` now runs
  `node dist/db/migrate.js && node dist/api/server.js` so migrations apply on
  boot. Must use the COMPILED migrator — `tsx` is a devDependency and is pruned
  from the production image. `railway.json` startCommand did NOT override the
  Dockerfile CMD (config-as-code is deprecated), which is why this lives in the
  Dockerfile.

- **Verified working end-to-end**: real prices extracted (Kroger: water $7.99,
  sugar $5.29, cheddar $3.95, yogurt $3.95; Walmart: cheddar $2.98, yogurt
  $2.77), aggregated, and published to Upstash with 26h TTLs and `state: OK`.
  US coverage 58.3% across 5 categories.

- **worldmonitor wired**: `CONSUMER_PRICES_CORE_BASE_URL` +
  `CONSUMER_PRICES_CORE_API_KEY` set in `.env.local` AND as GitHub repo secrets.

### Corrections to earlier analysis in this doc

- **Redis is NOT needed by the app** — the `redis` dependency is vestigial
  (only match in `src/` was the word "rediscovery" in a SQL comment). However
  **Upstash IS required by `jobs/publish.ts`**, which writes the snapshots
  worldmonitor reads. Upstash creds are set on both services.

- **Playwright/Chromium is NOT needed** — all 19 enabled retailers use
  `acquisition.provider: exa`.

- **BUT Firecrawl IS required** (this was initially called optional, wrongly).
  All 19 enabled retailers use `adapter: search`, and `scrape.ts` hard-requires
  BOTH `EXA_API_KEY`/`EXA_API_KEYS` (discovery) and `FIRECRAWL_API_KEY`
  (extraction). The adapter and the acquisition provider are different things.

- `seed-consumer-prices.mjs` in worldmonitor is a **manual fallback only** — it
  refuses to run without `--force` because it stomps publish.ts's 26h TTLs. The
  authoritative path is CPC's own publish job → Upstash → worldmonitor.

### Cost reality (measured, not estimated)

One retailer-run consumes ~60 Firecrawl credits (12 basket items x ~5 candidate
URLs). Free tier is 1,000 credits/month, resetting Sep 29.

| Cadence | Firecrawl credits/mo | Fits free tier? |
|---|---|---|
| 2 US retailers daily (current) | ~3,600 | No |
| All 19 retailers daily (design intent) | ~34,000 | No |
| ~1 retailer every other day | ~900 | Yes (barely) |

The 26h publish TTL means sub-daily cadence lets keys expire and datasets go
EMPTY again, so daily is required by design. **Running this properly costs
~$21-24/mo**: Railway Hobby $5/mo (trial: 30 days left) + Firecrawl ~$16-19/mo.
Currently scoped to 2 US retailers; widening to all 19 is a one-line change to
the `cpc-jobs` start command once the Firecrawl plan is upgraded.

### Credentials created (all in Aside vault)

- "consumer-prices-core (Railway) — API key + endpoint" — base URL + shared
  secret (CPC's `WORLDMONITOR_SNAPSHOT_API_KEY` == worldmonitor's
  `CONSUMER_PRICES_CORE_API_KEY`; same value, two names)

- "Exa API key" — pre-existing key retrieved from dashboard.exa.ai
- "Firecrawl API key" — new account via Google SSO, free tier
- "Telegram API app — WorldMonitor Feed" — `api_id` 33898091

---

## 1. consumer-prices-core — the biggest single blocker (~13 datasets) [RESOLVED, see above]

Lives in-repo at `consumer-prices-core/`. CI builds and tests it
(`test.yml`, `security-audit.yml`) but **no deploy workflow exists** and no
running instance was found. `CONSUMER_PRICES_CORE_API_KEY` and
`CONSUMER_PRICES_CORE_BASE_URL` are empty placeholders in `.env.local`, so
`scripts/seed-consumer-prices.mjs` fails closed and all downstream consumer
price datasets stay EMPTY.

**Hard requirements (from `package.json` + `Dockerfile`):**

- **PostgreSQL** — `pg` driver, 10 migrations (`migrations/001…010`)
- **Redis** — `redis` client
- **Playwright + Chromium** — Dockerfile installs a full browser + X11/font stack
- **Exa** (`exa-js`) — `EXA_API_KEY` currently absent
- Fastify API on :3400, plus 3 job entrypoints: `jobs:scrape`,
  `jobs:aggregate`, `jobs:publish`

- Firecrawl optional (`FIRECRAWL_API_KEY`) via `src/acquisition/registry.ts`

**Architectural constraint — IMPORTANT:** this is a stateful, browser-driving
service backed by a relational DB. It cannot run on Convex (document store +
TS functions, not Postgres) and does not fit a plain Worker. It needs either a
container host with a Postgres, or a rewrite.

**DECIDED 2026-08-29:** Postgres will be **Supabase**. Host for the container
still open (Cloudflare Containers is the likely candidate, matching the pattern
used for the trading books). The Dockerfile comments reference Railway build
failures, i.e. it was originally targeted at Railway, which is no longer used
for this project.

**BLOCKED on Supabase project creation — free-tier quota.** Supabase caps free
projects at **2 per owner across ALL organizations**. Current state after
tonight's cleanup:

| Org | Project | State | Notes |
|---|---|---|---|
| SIBT | **SIBT** (`twyzyvgqzzuvlvsftcjj`) | Active, PRODUCTION | worldmonitor auth (`supabase-js` sessions in `pro-test/`) AND should-i-be-trading. Do not touch. |
| SIBT | nkrvivek's Project | Paused | Generic name, purpose unverified, not referenced in any local `.env` |
| nkrvivek personal | **viyan** | Active | Son's chores/games/allowance app. 27 MB, 2 MAU. **Keep.** |
| SIBT | ~~sibt-staging~~ (`hoazewfoeddyoldaglpf`) | **DELETED 2026-08-29** | Was paused, unreferenced |

At 3 projects, creation is blocked; the account must be at 1 to create a new
free project. That would require deleting BOTH `nkrvivek's Project` and
`viyan` — and `viyan` is in active use, so this is off the table.

**Therefore: creating the CPC project requires Supabase Pro (~$25/mo).**
Independently recommended anyway — free-tier projects auto-pause on inactivity
(two already had), which is precisely the silent-death failure mode this whole
triage exists to eliminate. A continuously-scraping price pipeline should not
sit on a tier that suspends itself. Pro also protects `viyan` from pausing.

AWAITING VIVEK'S DECISION on the upgrade. Nothing else about CPC can proceed
until the database exists.

## 2. Platform history (corrected 2026-08-29)

Do not trust older comments/agent notes on this point:

- **Railway is NOT used for worldmonitor anymore.** Seeders and docs that refer
  to a Railway relay (`a5f66d97-…`) and "the Railway Telegram OSINT poller" are
  referring to a decommissioned host. `socialVelocity`, `wsbTickers`, `pizzint`,
  `productCatalog`, `sectors` and `digestNotifications` are therefore not
  "broken code" — they are addressed to a platform that no longer exists and
  need re-homing.

- **Current planes: Convex + Cloudflare** (plus GitHub for CI only).
- Supabase org "SIBT" exists with 3 projects (SIBT active/nano; "nkrvivek's
  Project" and "sibt-staging" both PAUSED), Free plan, 32 MB/500 MB used.
  Whether Supabase is still in use for worldmonitor is UNCONFIRMED — verify
  before building on it. Note free-tier projects auto-pause on inactivity,
  which is a poor fit for a continuously-scraping service.

## 3a. CREDENTIAL STATUS (updated 2026-08-30)

| Env var | Service | Status |
|---|---|---|
| `ABUSEIPDB_API_KEY` | AbuseIPDB | **DONE.** Key "worldmonitor-cyberthreats" created, live-tested against /v2/check. In vault + .env.local + GH secret. Free tier 1,000 checks/day. |
| `TELEGRAM_API_ID` / `_HASH` / `_SESSION` | Telegram | **DONE.** App "WorldMonitor Feed" (api_id 33898091) + GramJS StringSession minted 2026-08-30. All three in vault + .env.local + GH secrets. |
| `EXA_API_KEY` / `EXA_API_KEYS` | Exa | **DONE.** Pre-existing key retrieved from dashboard.exa.ai (team "Vivek Raghunathan's Personal", 10 QPS). Wired to Railway CPC. |
| `FIRECRAWL_API_KEY` | Firecrawl | **DONE.** New account via Google SSO, free tier 1,000 credits (resets Sep 29). Wired to Railway CPC. |
| `OTX_API_KEY` | AlienVault/LevelBlue OTX | **BLOCKED — needs Vivek.** Email signup is gated by an **Arkose Labs FunCaptcha** (human-verification; not appropriate or feasible to bypass). Google SSO grants OAuth consent but OTX never establishes the session and loops back to /accounts/signup/ (attempted 3x). Signup form is otherwise complete: username `nkrvivek`, email nkrvivek@gmail.com, password generated. |
| `URLHAUS_AUTH_KEY` | abuse.ch | **BLOCKED — their outage.** `auth.abuse.ch` TLS cert **expired 2026-08-29 07:08:43 UTC** (`ERR_CERT_DATE_INVALID`). Verified via openssl; `urlhaus.abuse.ch` cert is valid to 2027-01-10, so only the auth subdomain is affected. Did NOT click through the cert warning to register. **Retry in a day or two.** |
| `USPTO_API_KEY` | USPTO Open Data Portal | **BLOCKED — needs Vivek.** Since 2026-06-18 ODP requires a USPTO.gov account **with mandatory MFA**; since 2026-08-18 four extra profile fields are required or API access is revoked. Identity-verified government account. |
| `RELIEFWEB_APPNAME` | ReliefWeb | **BLOCKED — needs their approval.** Account verification email received 2026-08-13 but no approved appname. Per `seed-climate-disasters.mjs:213-221` the appname must come from their request form and cannot be self-chosen (v2 returns 403). |
| `STRIPE_SECRET_KEY` | Stripe | Not attempted — existing financial account, needs Vivek. |

**cyberThreats requires ALL THREE of AbuseIPDB + OTX + URLhaus**, so it stays dark
until OTX and URLhaus land. riskScores is downstream of cyberThreats and clears
with it.

## 3. Missing third-party credentials (verified absent) [SUPERSEDED by 3a above]

| Env var | Service | Unblocks | Status |
|---|---|---|---|
| `ABUSEIPDB_API_KEY` | api.abuseipdb.com | cyberThreats → riskScores | Account CREATED 2026-08-29 (nkrvivek@gmail.com, Innocore LLC, free tier, email verified). **Password state unverified — see Known Issues.** API key not yet generated. |
| `OTX_API_KEY` | otx.alienvault.com | cyberThreats | Not started |
| `URLHAUS_AUTH_KEY` | urlhaus-api.abuse.ch | cyberThreats | Not started |
| `USPTO_API_KEY` | USPTO | defensePatents | Not started. No prior signup found in either inbox. |
| `FIRECRAWL_API_KEY` | api.firecrawl.dev | groceryBasket, CPC acquisition | Not started |
| `EXA_API_KEY` | api.exa.ai | groceryBasket, CPC | Absent |
| `RELIEFWEB_APPNAME` | ReliefWeb | climateDisasters | Account verification email received 2026-08-13, but **no approved appname**. Per `seed-climate-disasters.mjs:213-221`, the appname must be approved via their request form and "cannot be invented" (v2 returns 403 for self-chosen names). |
| `STRIPE_SECRET_KEY` | Stripe | productCatalog | Absent; likely an existing account, not a signup |

Feodo and C2IntelFeeds (also in cyberThreats) are keyless and unaffected.

## 4. Telegram — resolved

`telegramFeed` needs **MTProto user credentials**, not a bot token:
`scripts/telegram/session-auth.mjs` uses GramJS `StringSession` with
`TELEGRAM_API_ID`/`TELEGRAM_API_HASH`. A bot token cannot read arbitrary public
channels. (The existing `TELEGRAM_BOT_TOKEN` in autopilot-experiment and
trade-refresh is for *sending* — different purpose.)

Checked `my.telegram.org/apps` on account **+1 408 505 1941**: no pre-existing
app existed. Created one on 2026-08-29:

- App title: **WorldMonitor Feed**, short name `worldmonitorfeed`
- `api_id`: **33898091**
- `api_hash`: stored in Aside vault (item "Telegram API app — WorldMonitor Feed")
- Platform: Other; described as read-only public-channel ingestion, no sending

**Still needed:** `TELEGRAM_SESSION`, generated by running
`scripts/telegram/session-auth.mjs` with the above credentials. It triggers a
login code, which now arrives in the logged-in Telegram Web session.

## 5. Ortex — retired, not broken

The Ortex subscription was **cancelled**. Signals #20/#21/#22 are affected:
#20 (squeeze mechanics) degrades to the pre-existing UW + FINRA/IBKR path;
**#21 (ortex_alpha) and #22 (pcr_bull_shift) are gone with no equivalent
source.** Going forward the paid data subs are **ORATS + UW + FMP**.

## 6. Scheduling — GitHub cron is unreliable here

Measured over 24h (`gh run list`, event=schedule):

| Workflow | Configured | Expected/day | Actual/day |
|---|---|---|---|
| analytics-collector-monitor | `*/5` | ~288 | 3 |
| warm-ping | `7,22,37,52 * * * *` | ~96 | 3 |
| deploy-gate | `*/30` | ~48 | 2 |
| seed-fallback | `17 * * * *` | 24 | 2 |
| seed-military-flights | `7 * * * *` | 24 | 2 |

`seed-fallback` has **never** fired at minute 17, with gaps up to 13.3 hours —
longer than several seeds' entire staleness budget (theaterPosture 180m,
newsInsights 75m). Note this repo is **private**, so Actions minutes are
metered; quota exhaustion may compound GitHub's own best-effort scheduling.

Consequence worth calling out: `warm-ping` exists to keep the
`news:digest:v1:full:en` cache warm. Running 3×/day instead of 96×/day means
cold caches, which is the likely root cause of the digest build timeouts that
were being patched with retry ladders (see the 2026-08-26 commits). Those
patches treated a symptom.

**Recommendation:** move scheduling off GitHub. Convex has native cron support
and already runs several jobs (`convex/crons.ts`); Cloudflare Worker crons are
the other option and are already proven in this stack. Jobs that are just HTTP
pings (warm-ping, likely deploy-gate) can move into a Worker outright.

## 7. Convex deploy key gap

`.github/workflows/convex-deploy.yml` documents that the prod deployment exists
(`benevolent-impala-683`) but `CONVEX_DEPLOY_KEY` is missing, so the workflow
warns and stops rather than deploying. Confirmed absent from the repo secret
list. **Convex deploys have therefore never run automatically.** Fix: mint a
"Production: deploy" key in the Convex dashboard, add as a repo secret.

## Known issues / honest caveats

- **AbuseIPDB password unverified.** The account is real and email-verified, but
  the password was set via the browser extension's generated-password prompt
  after a direct fill failed, and `autofillItem` would not populate the login
  form to confirm the stored value. The vault item
  "AbuseIPDB (worldmonitor cyberThreats)" may hold a stale password. Password
  reset to nkrvivek@gmail.com works and delivers promptly, so recovery is cheap.
  **Verify before relying on it.**

- Railway could not be inspected: dashboard login requires a passkey, and the
  WebAuthn assertion did not complete from the automated browser across three
  attempts. Moot if Railway is genuinely retired, but noted.

- The earlier claim that the Seed Freshness Monitor fails because acknowledged
  items exit non-zero was **wrong**. Its exit semantics were already correct;
  red runs reflect genuinely unacknowledged breakage. The real defect (fixed
  2026-08-29, commit 85b9c0033) was that acknowledgements matched on
  `name:status` only and never expired against the measurement that justified
  them — e.g. `portwatchPortActivity` acknowledged at 159 countries still
  printing "acknowledged" at 128.

## Suggested order of work

1. Decide the CPC host + Postgres question (§1) — unblocks ~13 datasets
2. Mint `CONVEX_DEPLOY_KEY` (§7) — one minute, unblocks automated Convex deploys
3. Move the high-frequency schedules off GitHub (§6) — fixes digest timeouts
4. Re-home the 5-6 Railway-orphaned seeders (§2)
5. Free API signups (§3) — 4 datasets
6. `TELEGRAM_SESSION` (§4) — 1 dataset
7. ReliefWeb appname request (§3) — needs their approval, so start early
