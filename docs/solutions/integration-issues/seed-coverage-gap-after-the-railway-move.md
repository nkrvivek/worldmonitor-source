# The seed coverage gap the health endpoint was hiding

Routing `/api/health` in the Worker (`worker/routes/health.ts`) made the site's
own status readable for the first time. It reports:

```
"status":"UNHEALTHY"  total 253 · ok 116 · warn 19 · onDemandWarn 21 · crit 97
Ingestion operational acceptance failed: 116 unacknowledged problem(s).
```

97 checks sit at `status=EMPTY records=0`. None of this was caused by the
routing change — the endpoint had never answered, so nobody could read it.

## The rail itself works

Read production Upstash directly before blaming the container rail. It holds
152 `seed-meta:*` keys, every one carrying a timestamp, the freshest written
minutes ago. `wrangler tail` catches the `*/5` and `*/15` crons firing and four
`SeedContainer` `start` RPCs behind them.

So the question is not "do seeds run here". It is "which ones fail, and why".

## What the empty checks split into

Match each empty check against Redis rather than against the registry.

| Group | Count | What it means |
|---|---|---|
| No data key and no `seed-meta` key | 114 | Nothing has ever produced it here. |
| Fresh `seed-meta`, no data key | 4 | The seed ran; the check reads a different key. |

The second group is small and exact. `techEvents` proves the shape:
`seed-meta:research:tech-events` reads `recordCount 128`, the canonical key
`research:tech-events:v1` holds 34 KB — and the health check reads
`research:tech-events-bootstrap:v1`, which does not exist. Four checks are
bootstrap-keyed this way (`cyberThreats`, `flightDelays`,
`securityAdvisories`, `techEvents`), and the script that writes the bootstrap
tiers, `scripts/publish-bootstrap-tiers.mjs`, is in no registry entry.

## Why each failing member fails

`worker/seeds/registry.ts` registers 46 scripts; following bundle members
reaches 135. Running the failing ones locally against production Redis gives
the reason for each. They are five different faults, not one.

| Check | Why it writes nothing |
|---|---|
| climateAirQuality, healthAirQuality | `seed-health-air-quality.mjs` throws on a missing `OPENAQ_API_KEY`. Fixed 2026-08-06: the secret is set, and a local run wrote 6,203 records to both keys. |
| eiaPetroleum | `seed-eia-petroleum.mjs:99` throws on a missing `EIA_API_KEY`. Fixed 2026-08-06: the secret is set, and the seed already runs inside `seed-bundle-energy-sources.mjs`. |
| ucdpEvents | `seed-ucdp-events.mjs` wants `UCDP_ACCESS_TOKEN` or `UC_DP_KEY`. |
| jodiGas, jodiOil | Upstream gap, not our config: `China JODI gas coverage failed: china-missing (dataMonth=missing)`. The seed refuses to publish a world figure without China. |
| lngVulnerability | Reads JODI-Gas's `seed-meta` key. Follows from the row above. |
| climateZoneNormals | Open-Meteo answers 429 batch after batch; the fetch phase trips the script's own 240 s deadline at 240336 ms. |
| climateAnomalies | `Missing climate:zone-normals:v1 baseline`. Follows from the row above. |
| wildfires | No producer runs. `scripts/seed-fire-detections.mjs` writes `wildfire:fires:v1`, needs `NASA_FIRMS_API_KEY`, and appears in no registry entry. Fixed 2026-08-06: the secret is set and the script runs at `8 * * * *`. A local run fetched 32,322 detections across three VIIRS sources in 180 s and published 15,000 under the 5 MB cap. |
| thermalEscalation | Reads `wildfire:fires:v1`, finds nothing, declares 0 records, exits in 330 ms. Follows from the row above, and clears with it — its own cron at `15 */3 * * *` was never the problem. |
| fatfListing | Unexplained. See below. |
| techEvents | Key mismatch, above. |

Three of those are cascades — `lngVulnerability`, `climateAnomalies` and
`thermalEscalation` fail because a producer upstream of them failed. Fix the
producer and the pair clears together.

`fatfListing` is the one still open. Run locally it **succeeds**: 61628 ms,
25 records, `"state":"OK"`, "Verified: data present in Redis". It takes a 403
from fatf-gafi.org and recovers through the Wayback Machine. Its bundle allows
300 s, so the container failure is not a timeout. `PROXY_URL` was unset locally
and the run still worked, which rules that out too. That local run has since
populated `economic:fatf-listing:v1` in production, so the next health poll
will read it — do not mistake that for a container fix.

It stayed unexplained because nothing could see the failure. Every other macro
section is fresh, so the bundle does reach its last section: not truncation,
not deferral (`seed-bundle-macro.mjs` passes no `maxBundleMs`), not a
`requiredEnv` gate, not a timeout. The remaining shape is egress — and the
runner's account of it went to stdout, which on a Cloudflare container nobody
can read. `wrangler tail` shows the cron invocation and the container's start
RPC with `logs: []`, and `wrangler containers` has no logs subcommand.

So `_bundle-runner.mjs` now writes each run to `seed-run:<bundle>`: per-section
status, elapsed time, record count, and the failure reason, plus the run
counters, with a 35-day TTL — longer than the longest section interval, so the
record explaining a monthly section outlives it. The write is best effort and
runs after the loop: a bundle whose sections all succeeded still exits 0 when
Redis is unreachable. Read it with `node scripts/show-bundle-run.mjs macro`.

A failing section also carries the last 12 lines of its own stderr. The first
live record proved why: it named `Air-Quality FAILED` with reason `exit 1`,
which says a section failed and nothing about what it hit. The runner's reason
is the exit code, so the child's last words are the only account of the cause,
and in a container they reach nobody else. A section that succeeded carries no
tail — it already explains itself.

FATF itself will not re-run until roughly 2026-09-04: its interval is 30 days
and the local run above wrote the marker, so the section now skips. The record
will hold the answer on that tick.

## The allowlist gap behind three of them

A container inherits nothing from the Worker. `worker/seeds/env.ts` forwards an
explicit allowlist, and a name missing from it reaches the script as
`undefined`. Sweeping all 135 reachable scripts plus the shared helpers found
17 scripts reading 25 names the list did not carry — including the three hard
blocks above.

The list now carries every credential-shaped one, and
`tests/worker/seed-env.test.mts` fails when a reachable script reads a name that
is neither forwarded nor recorded in `SEED_ENV_NOT_FORWARDED` with a reason.
Adding a seed that reads a new key now breaks the suite instead of going quiet.

Widening the list changes nothing on its own: none of those values is set
anywhere yet. It removes the second round trip — set the secret and the seed
runs, with no code change in between.

## Scheduled, cron has not come round yet (11)

Not broken. The rail is younger than the schedule.

| Bundle or script | Cron | Last due | Empty members |
|---|---|---|---|
| `seed-bundle-static-ref.mjs` | `0 3 * * SUN` | 2026-08-02 | submarineCables, defensePatents, chokepointBaselines |
| `seed-bundle-imf-extended.mjs` | `0 8 3 * *` | 2026-08-03 | imfGrowth, imfLabor, imfExternal |
| `seed-bundle-resilience-recovery.mjs` | `0 4 1 * *` | 2026-08-01 | recoveryImportHhi, recoveryReexportShare, recoverySovereignWealth |
| `scripts/seed-comtrade-bilateral-hs4.mjs` | `0 6 1 * *` | 2026-08-01 | comtradeBilateralHs4 |
| `scripts/seed-aaii-sentiment.mjs` | `0 12 * * THU` | 2026-07-30 | aaiiSentiment |

Every one of those dates precedes the rail, except IMF, whose registry entry
landed a day after its monthly firing. Next chances: static-ref on 2026-08-09,
aaii on 2026-08-06, the monthlies in September.

`Defense-Patents` needs `USPTO_API_KEY`, now on the allowlist and still unset.
Set it before 2026-08-09 or that member joins the failing group.

A healthy key is not evidence that the Worker produced it — Railway-era values
are still expiring. `seed-bundle-static-ref` has not fired here at all, and its
`Military-Bases` key has since gone from healthy to absent, which is what a
Railway value looks like when its TTL runs out.

## No cron at all (62)

```
bigmac chokepointFlows chokepointFlowsRelayHeartbeat chokepointTransits
climateNewsRelayHeartbeat consumerPricesCategories consumerPricesCoverage
consumerPricesFreshness consumerPricesMovers consumerPricesOverview
consumerPricesSpread crossStraitActivity crossStraitActivityJapanMod
crossStraitActivityTaiwanMnd crudeInventories cyberThreats digestNotifications
economicStress electricityPrices energyPrices flightDelays forecastFredCpiaucsl
forecastFredDcoilwtico forecastFredDgs10 forecastFredGdp forecastFredM2sl
forecastFredT10y2y forecastFredUnrate forecastFredVixcls forecastFredWalcl
forecastResolutions forecasts forecastScorecard fredBatch fuelPrices
groceryBasket gscpi marketImplications militaryCii militaryFlights
natGasStorage oilStocksAnalysis pizzint productCatalog refineryInputs
regionalBriefs researchArxivHnTrending resilienceIntervals riskScores
satellites sectors securityAdvisories shippingStress socialVelocity spr
tariffTrendsUs telegramFeed temporalAnomalies theaterPosture transitSummaries
webcams wsbTickers
```

Add `wildfires` to this group — the table above misplaced it under a cron that
consumes its key rather than writes it.

The registry header already explains part of the list. Seeds needing a key the
Worker does not hold (three threat feeds for `seed-cyber-threats`, an LLM
provider for `seed-forecasts` and `seed-bundle-regional`) were left out on
purpose, as was `seed-bundle-resilience-validation`, which needs a tsx loader
`Dockerfile.seeds` does not install. That covers `cyberThreats`, the nine
`forecastFred*` keys, `forecasts` and `regionalBriefs`.

Three of that group left it on 2026-08-06, when the keys arrived. `EIA_API_KEY`
and `NASA_FIRMS_API_KEY` are set, so `seed-economy` (`0 9 * * *`),
`seed-fuel-prices` (`0 10 * * SUN`) and `seed-fire-detections` (`8 * * * *`) now
have cron lines, and `fuelPrices`, `wildfires` and `thermalEscalation` clear
with them. Each cadence comes from the seed's own TTL comment rather than a
guess: 26 h on FRED, 10 days on fuel prices, 2 h on fire detections.

### Where the remaining ones went (measured 2026-08-05)

Map each check to its `seed-meta` key, the key to the script that writes it,
and that script to the reachable set. The list splits three ways.

**Six were grouped wrong. A cron does reach them**, so they ran and still wrote
nothing — they belong in the failing table above, not here.

| Check | Writer | Reached through |
|---|---|---|
| crossStraitActivity, …JapanMod, …TaiwanMnd | `seed-cross-strait-activity.mjs` | `seed-bundle-derived-signals.mjs` (`*/5`) |
| researchArxivHnTrending | `seed-research.mjs` | registry root (`35 */6`) |
| tariffTrendsUs | `seed-supply-chain-trade.mjs` | registry root (`0 */6`) |
| oilStocksAnalysis | `seed-iea-oil-stocks.mjs` | `seed-bundle-energy-sources.mjs` |
| resilienceIntervals | `seed-resilience-scores.mjs` | `seed-bundle-resilience.mjs` |

`resilienceIntervals` in particular is not the validation bundle's — its writer
sits in the plain resilience bundle, which runs every six hours.

**Eleven writers need a credential this fork does not hold.** The registry
header now records each one, so a reader no longer has to re-derive it:
`seed-consumer-prices` (six checks plus seven per-country slices),
`seed-aviation`, `seed-electricity-prices`, `seed-bigmac`,
`seed-grocery-basket`, `seed-webcams`, `seed-military-flights`,
`seed-forecast-resolutions`, the two relay-backed seeds below, and
`seed-forecast-bets`, a shadow engine gated behind `FORECAST_BETS_ENSEMBLE=1`
that never writes the user-facing key.

**One had no reason at all.** `scripts/seed-chokepoint-flows.mjs` reads nothing
but Upstash, and all three of its inputs already have crons —
`supply_chain:portwatch:v1` and `portwatch:disruptions:active:v1` from
`seed-bundle-portwatch`, `energy:chokepoint-baselines:v1` from
`seed-bundle-static-ref`. It now has a `55 */6 * * *` line. The baselines key
only lands after static-ref fires on 2026-08-09, so expect the first runs to
find one input missing.

The relay-backed keys are a separate case. `chokepointTransits`,
`chokepointFlows` and the two `*RelayHeartbeat` keys come from
`scripts/ais-relay.cjs`. Only `/ais/snapshot` was ported to the Worker;
`wrangler.jsonc` records that `/telegram`, `/ucdp-events` and the rest of the
old Node relay's paths 404 here. `telegramFeed` follows from that. Neither
`*RelayHeartbeat` key carries a `SEED_META` row, so nothing ties them to a
producer either way. `seed-military-cii` (`WS_RELAY_URL`) and
`seed-security-advisories` (`RELAY_URL`, defaulting to
`proxy.worldmonitor.app`) read the same dead relay.

`productCatalog` and `theaterPosture` match no script in the tree.

## No `seed-meta` entry (11)

```
consumerPricesCoverageAU consumerPricesCoverageBR consumerPricesCoverageGB
consumerPricesCoverageIN consumerPricesCoverageSA consumerPricesCoverageSG
consumerPricesCoverageUS militaryFlightsStale newsInsights
theaterPostureBackup theaterPostureLive
```

These are checked but carry no staleness registration, so nothing ties them to
a producer. Seven are per-country slices of the same dead `consumerPrices`
family.

## One failure the health checks do not see

`seed-iea-oil-stocks.mjs` fails deterministically and its key is not in the
empty list, because a Railway-era value is still standing in for it:

```
CONTRACT VIOLATION on extraKey energy:iea-oil-stocks:v1:AU: re-exports 1
pre-publish field(s) that publishTransform strips from the canonical key:
seededAt.
```

That is a code fault in the seed, fixable without any secret. When the old
value expires, the check flips to EMPTY with no new information.

## What this means for the monitor

`.github/workflows/seed-freshness-monitor.yml` stays off in the Actions tab.
Its acceptance step now has an endpoint to read, which was the blocker, but the
seeds report 116 unacknowledged problems — it would fail every 15 minutes. Turn
it on once `node scripts/check-seed-freshness.mjs` passes.

The run reports two baseline entries as recovered and prompts you to prune
them. Do not prune either yet.

`humanitarianSummary` (#5769) carries its own warning in
`scripts/seed-freshness-baseline.json`: the source "recovers intermittently
between health snapshots, so one green poll is not evidence of recovery."
One green poll is exactly what we have.

`crossStraitActivityJapanMod` (#5714) did not recover. It moved from
`SEED_ERROR` to `EMPTY`, and the baseline matches on `name:status`, so the old
entry no longer applies. A cron does reach it — `seed-cross-strait-activity.mjs`
is a member of `seed-bundle-derived-signals`, which runs every five minutes — so
the seed is running here and writing nothing. That is a live failure, not a
scheduling gap, and it needs the same local run the table above used.

Both reasons describe Railway egress, which this fork no longer uses. They need
re-checking against Cloudflare egress before either entry is trusted or
dropped.

## The next probe

Container stdout is not observable. `wrangler tail` shows the cron invocation
and each `SeedContainer` `start` RPC with `logs: []`, and `wrangler containers`
has no `logs` subcommand. Do not plan a diagnosis around reading a seed's output
from the edge — run the script locally with Upstash credentials and read the
error there. That is how every row in the table above was settled.

What is left, in order of cost:

1. Set `OPENAQ_API_KEY`, `EIA_API_KEY` and a UCDP token. Done for the first two
   on 2026-08-06 — both are Worker secrets, and each seeder was run locally
   against production Redis first to prove the key works. The UCDP token
   followed on 2026-08-11, the same way, and `ucdpEvents` is no longer empty:
   the seeder wrote 2,000 events from v26.1 merged with candidate v26.0.6, and
   `/api/conflict/v1/list-ucdp-events` serves them. UCDP allows 5,000
   authenticated requests a day, counted per page and including pages that
   error, resetting at midnight UTC — the seeder's `MAX_PAGES` of 6 plus its
   six candidate probes sits far under that, but a retry loop that ignores the
   cap would not.

   `ENTSO_E_TOKEN` belongs on the same list and was set 2026-08-11, the same
   way: Worker secret on `worldmonitor-web`, seeder run locally first. All ten
   ENTSO-E bidding zones answered with a price, above the seven
   `MIN_ENTSO_REGIONS` needs, so the EU half of `seed-electricity-prices` no
   longer warns and skips. That run wrote 17 regions (10 ENTSO-E, 7 EIA-930).
   A token that authenticates can still return an `Acknowledgement_MarketDocument`
   with reason 999 for a zone-and-window pair that has no published price —
   that is missing data, not a bad token, so do not read one 999 as a failed
   credential.
2. Set `NASA_FIRMS_API_KEY` and give `scripts/seed-fire-detections.mjs` a cron
   line. Done 2026-08-06. `thermalEscalation` clears with it. Setting
   `EIA_API_KEY` also freed `seed-economy` and `seed-fuel-prices`, which the
   registry had excluded for the same reason; both now have cron lines.
3. Fix the `seed-iea-oil-stocks.mjs` extraKey transform. Done — the country
   extraKey now declares `allowPrePublishFields: ['seededAt']`, and the seed
   writes 32 records again.
4. Find why `fatfListing` fails in a container while succeeding locally. The
   runner now records every run to `seed-run:<bundle>`, so the next macro tick
   after 2026-09-04 carries the reason instead of losing it to unread stdout.
5. Batch or back off `seed-climate-zone-normals.mjs` against Open-Meteo's 429s.
   `climateAnomalies` clears with it. Done — the walk now carries a 300 s
   budget shared by every batch, `fetchOpenMeteoArchiveBatch` skips a
   Retry-After sleep that would land past it and goes to the proxy legs
   instead, and the lock widened to 360 s so the derived fetch deadline is
   480 s rather than 240 s. A slow run publishes the zones it reached — 17 of
   25 is enough — instead of throwing with nothing written.

6. Find why the cross-strait section writes nothing. Done — the section
   required `JAPAN_MOD_PROXY_URL` or `PROXY_URL`, a Railway-era guard against
   egress Japan MoD blocked. This fork sets neither name anywhere, and
   `worker/seeds/env.ts` drops a blank, so the gate reported `CONFIG_ERROR`
   every tick and the seed never ran. Run direct it takes 21 s and writes 21
   records from both sources. The gate is gone; the completion marker still
   makes a partial cohort retry instead of publishing. Verified live after the
   deploy: `seed-meta:military:cross-strait-activity` now holds 21 records at
   `sourceVersion: taiwan-mnd-html+japan-joint-staff-homepage-v2`, and the
   completion marker and the Japan MoD per-source key both exist. All three
   cross-strait checks clear together.

JODI needs nothing from us — the gate is doing its job on a source that has not
published China.

Rerun this map after 2026-08-09. By then static-ref and aaii will have fired,
and any of their members still empty moves out of the waiting group and into
the failing one.

## 2026-08-09 — batch 1 against the live health map

Re-derived the work list from the live compact health snapshot (251 checks,
81 problems, crit 49) instead of the stale 62-list above.

1. `scripts/fetch-gpsjam.mjs` had no schedule anywhere — the one clean
   pure-cron loss. Wired at `0 11 * * *` (registry + wrangler crons, commit
   6c65ec477). No credentials beyond Redis; 48h TTL against a daily tick.
2. `scripts/seed-recall-benchmark.mjs` was never broken. The daily
   feed-validation run succeeds and logs
   `WARN: news:digest:v1:full:en missing/empty — cannot benchmark, skipping`.
   Its input is the on-demand digest cache that `seed-insights.mjs` warms
   through a self-call carrying `WORLDMONITOR_RELAY_KEY` — a credential the
   seed containers deliberately do not receive (`worker/seeds/env.ts`). Do
   not add a second benchmark cron; fix the digest warm path.
3. `scripts/seed-service-statuses.mjs` hardcodes
   `https://api.worldmonitor.app/...` as its RPC target — the upstream
   author's host, per the note in `.github/workflows/seed-fallback.yml` —
   and ignores `API_BASE_URL`. Probed live: 403 without the relay key.
   Same family as 2.

The warm-ping family (serviceStatuses, riskScores, cableHealth, chokepoints,
temporalAnomalies, and the digest chain feeding recallBenchmark) shares one
shape: a self-call needing `WORLDMONITOR_RELAY_KEY` + a correct base URL,
neither of which exists inside the seed containers. `seed-fallback.yml` has
both but stands down whenever CF crons are alive, so it never fires in steady
state. Batch 2 is one scheduled GitHub workflow that carries the key and the
sibt.ai base URL, plus making the warm-ping scripts honor `API_BASE_URL`
before pointing them anywhere.

## 2026-08-09 — batch 2 shipped: the warm-ping rail

Commit d5066d95e, both halves of the shape above:

1. **`.github/workflows/warm-ping.yml`** — half-hourly (`7,37 * * * *`),
   six curls against `https://worldmonitor.sibt.ai` carrying
   `WORLDMONITOR_RELAY_KEY`, no checkout, no npm ci. The path list mirrors
   `RELAY_WARM_PING_PATHS` in `server/gateway.ts`; the digest call is a GET
   with `variant=full&lang=en` so it fills the exact key recall-benchmark
   reads. The run fails when ANY path fails — steady state on our own
   gateway is 6/6, and a silent half-failure is the class this batch kills.
2. **Three scripts now honor `API_BASE_URL`** (upstream host stays the
   local-dev default): `seed-infra.mjs` (`API_BASE` const),
   `seed-service-statuses.mjs` (`RPC_URL` const), and `seed-forecasts.mjs`,
   which read `WM_API_BASE_URL` — a name nothing sets — and now accepts
   either. Until this, even seed-fallback runs pinged the upstream author's
   host despite exporting `API_BASE_URL`.

Verified live: dispatch run 31329974913 came back 6/6 OK, and an operator-key
read of the digest straight after returned 200 in 0.39s with
`generatedAt 2026-08-09T18:48:42.879Z` — the timestamp of the warm call
itself, i.e. the cache the benchmark starves without is now filled by this
rail. Next feed-validation daily run should benchmark instead of skipping.
