# Wiring WorldMonitor into sibt, trade-refresh and autopilot

Status: the two blockers below are gone. Eight signals answer with real data
today. trade-refresh pulls five of them as of 2026-08-06; the three trade
signals recovered later the same day and join the pull in step 5.

## What this is

WorldMonitor holds 35 data domains and 173 operations. Three other projects
could read them and today none do. This says which signals are worth pulling,
how the pull works, and what has to exist first.

WorldMonitor is a producer here, not a peer. It never reads the trading vault,
never knows a position exists, and never calls back. The consumers pull, on a
schedule, and write what they got into vault docs. That keeps the rule in
`AGENTS.md` §1 intact: shared through documents, never re-implemented.

## The consumers

**trade-refresh** — the interactive orchestrator. Wants regime and risk inputs
it cannot get from Unusual Whales: shipping stress, chokepoint status, energy
disruptions, food and fuel prices, sanctions changes.

**autopilot-experiment** — the quarantined auto-trader and the bildof cloud
rail. Wants a small, stable set: a daily risk reading it can gate on. Fewer
calls, harder freshness rules, no interactive judgment behind them.

**the sibt.ai dossier** — a reader, not a trader. Wants narrative context to
sit beside the numbers it already shows.

## The signals worth pulling

Named from the shipped OpenAPI specs, not invented:

| Signal | Operation | Domain | Why it matters to a book |
|---|---|---|---|
| Chokepoint status | `GetChokepointStatus` | SupplyChain | Hormuz, Suez, Panama, Malacca. Moves energy and shipping names on a day's notice. |
| Country chokepoint index | `GetCountryChokepointIndex` | SupplyChain | Which countries a closure actually hurts. |
| Shipping stress | `GetShippingStress` | SupplyChain | Rates and congestion in one number. |
| Energy disruptions | `ListEnergyDisruptions` | SupplyChain | Pipeline and refinery outages. |
| Critical minerals | `GetCriticalMinerals` | SupplyChain | The rare-earth and lithium leg of the AI-hardware thesis. |
| Macro signals | `GetMacroSignals` | Economic | One call for the macro overlay. |
| Economic stress | `GetEconomicStress` | Economic | Country-level stress, useful as a regime input. |
| Oil and gas inventories | `GetCrudeInventories`, `GetNatGasStorage`, `GetEuGasStorage` | Economic | Energy sleeve. |
| Trade restrictions | `GetTradeRestrictions`, `GetTradeBarriers` | Trade | Tariff and export-control changes before they price in. |
| Vessel snapshot | `GetVesselSnapshot` | Maritime | Already served from the Worker. |
| Navigational warnings | `ListNavigationalWarnings` | Maritime | Already served from the Worker. |

Chokepoint status is the one the user asked for by name. It is served, and it
returns nothing — see "What each signal actually returns" below.

## The two ways in

**MCP** for interactive work. WorldMonitor publishes an MCP server and an A2A
agent card at `/.well-known/agent-card.json`. A Claude session in trade-refresh
asks in words and the concierge routes to tools. Good for judgment, wrong for
anything that has to run the same way every day.

**REST with the operator key** for the scheduled pulls. Deterministic,
cacheable, one operation per call. Everything below assumes REST.

The MCP connector is currently signed out — only `authenticate` and
`complete_authentication` are exposed, so no data tool is reachable through it
yet.

## What used to block it, and why neither blocks it now

**"The domains are not ported."** They are. `worker/routes/domains.ts` pairs
all 35 domains with a gateway in one table, dispatched from
`worker/index.ts:283`. It landed in `1b450df84`, followed by `92101ded0` for
the relay calls that re-enter the Worker. `MARKET_PATHS_STAYING_ON_VERCEL` is
now an empty set. Every path in the table above answers.

**"API keys need a paid plan, and plans do not sell."** Only user keys do.
`api/_api-key.js` resolves three kinds, and the enterprise kind — a key listed
in the `WORLDMONITOR_VALID_KEYS` Worker secret — skips entitlement checks
entirely. Its own comment calls it "The ONLY kind that bypasses entitlement
checks (operator-issued)". `server/gateway.ts:1306` scopes the `apiAccess` gate
to `isUserApiKey`, so it never applies to an enterprise key. That is the right
rail for our own services calling our own Worker, and it needs no Convex user —
which matters, because every table in prod Convex is still empty.

An operator key is minted and installed. It lives in the gitignored
`/Users/Vivek/Development/autopilot-experiment/.env` as `WORLDMONITOR_API_KEY`,
beside the Cloudflare token the other projects already read from there. Send it
as `X-WorldMonitor-Key`. `secret put` applies to the running Worker on its own,
so this did not wait on the blocked deploy.

## What each signal actually returns

Swept authenticated on 2026-08-06. Eight carry real data and can be pulled today:

| Signal | State |
|---|---|
| `ListEnergyDisruptions` | pipeline and refinery events |
| `GetCriticalMinerals` | producer concentration, e.g. gallium 96.3% China |
| `GetCrudeInventories` | weekly EIA stocks through 2026-07-31 |
| `GetNatGasStorage` | weekly storage through 2026-07-24 |
| `GetEuGasStorage` | 57.87% full, injecting |
| `GetTradeBarriers` | 50 rows — recovered 2026-08-06, see step 3 |
| `GetTradeRestrictions` | 50 rows — recovered 2026-08-06, see step 3 |
| `GetTariffTrends` | 10 datapoints per reporter, all 288 reporters written |

`GetCountryChokepointIndex` needs an `iso2` and returns 400 without one. That is
the contract, not a fault.

The rest returned empty for two separate causes, kept here with their fixes so
neither gets re-diagnosed. The first is closed. The second is step 4, and it is
the only one still open.

**The TTL is shorter than the cron.** `GetMacroSignals` and
`GetEconomicStress` — and energy prices, which this document missed on the first
sweep. Fixed 2026-08-06; see step 2 below for the six places one stale fact was
sitting. `scripts/seed-economy.mjs` is registered on `0 9 * * *` —
once a day — and writes `economic:macro-signals:v1` and
`economic:stress-index:v1` with a 6-hour TTL. Both keys die at 15:00Z and stay
dead until the next run. Measured: the seed wrote at 2:00 AM PT, the keys
expired at 8:00 AM PT, and both read null at 1:58 PM PT. The `seed-meta:*`
companions survive because they get a 7-day TTL, so the seeder looks healthy
while the data is gone for 18 hours of every 24. The TTL comments date from
when the seeder ran every 6 hours; the Worker port moved it to daily and left
them. `FRED_TTL` in the same file already carries the fix as a comment —
"26h — survive daily cron scheduling drift".

**Nothing in the Worker writes the key at all.** `GetChokepointStatus`,
`GetShippingStress`, and `GetVesselSnapshot`. Chokepoint status sets
`upstreamUnavailable` from `transitSummariesMissing` alone, and both
`supply_chain:transit-summaries:v1` and its seed-meta are null. The only writer
is `scripts/ais-relay.cjs`, whose `startBootSeedLoop('TransitSummary', …)` at
line 8195 belonged to the long-running Railway relay. The port carried that
process's WebSocket duties into a Durable Object and left its seed loops
behind. `supply_chain:shipping_stress:v1` is orphaned the same way — note that
`seed-supply-chain-trade.mjs` writes `supply_chain:shipping:v2`, a different
key, so it does not cover this one.

## The contract for a pull

Every scheduled pull follows the same shape, and it is the shape the trading
vault already enforces:

- One script per signal group, in the consuming project. WorldMonitor holds no
  consumer code.
- Write the result to a vault doc with the source and the fetch time in the same
  line as the number. A figure with no age is not usable.
- A failed pull is named in the session opener and excluded from totals. Never
  degrade to a stale number quietly — `AGENTS.md` §3.
- Register the pull in `/Users/Vivek/Development/trade-refresh/rails.json` in the
  same change that builds it: a `ledger`, an `opener_step`, a `quiet_after_days`,
  and a `guard_test` that fails when the data goes quiet. No row, no rail. Seven
  checks have now gone silent for exactly this reason.
- Freshness bounds follow R21: regime-shaped inputs 60 minutes, anything used in
  an order decision 5 minutes. Chokepoint status changes over days, so a 6-hour
  bound is honest for it — write the bound down rather than inheriting one.

## Order of work

Steps 1 and 2 — the API key and the supply-chain port — are done. What remains:

1. ~~Build the pull in trade-refresh, over all five signals that have data.~~
   **Done 2026-08-06.** `src/worldmonitor_pull.py` in trade-refresh writes
   `wiki/trading/worldmonitor-signals.md`, registered as opener step 1o with a
   guard test. First run read 5/5.

   Two things it measured that this document had wrong. Crude inventories and
   natural gas storage return no `fetchedAt` at all, and the EU gas figure
   returns one hours ahead of the data behind it — so the row carries the
   payload's own date, not the fetch time. And Cloudflare blocks the default
   `Python-urllib` signature with error 1010: a 403 that reads exactly like a
   rejected key. Any consumer written here must send a named User-Agent.
2. ~~Raise the two economic TTLs to 26 hours.~~ **Done 2026-08-06.** It was not
   one line and it returns three signals, not two.

   One fact — `seed-economy.mjs` used to run every 6 hours and now runs once a
   day — had been left behind in six places:

   - Four TTLs sized to the old cadence, not two. `ENERGY_TTL` was 3600, so
     `economic:energy:v1:all` existed for one hour in every twenty-four.
     `CAPACITY_TTL` equalled the interval exactly, dying the moment the next run
     was due. All four now 93600.
   - Three health bounds at 150, 150 and 180 minutes against a 1440-minute
     interval. Those alarm STALE on a healthy daily seeder, and their comments
     described an hourly cron that no longer exists. All three now 1560.
   - `macroSignals` sat in `ON_DEMAND_KEYS`, so its absence reported
     `EMPTY_ON_DEMAND` and was subtracted from the warn count. The seeder is its
     only writer and the RPC only reads, so nothing populates it after a user
     action — the same shape as the `marketImplications` incident the policy
     block above that set was written for. Removed.
   - `scripts/regional-snapshot/freshness.mjs` marked the same two keys stale
     after 60 and 120 minutes, so the snapshot writer would have rejected the
     data even once the TTLs were right. Both now 1560, matching health.
   - `server/worldmonitor/resilience/v1/_standalone-source-thresholds.ts` held a
     sixth copy of the energy-prices bound at 150.

   Measured live at 750 minutes past a healthy seed: `economicStress` EMPTY,
   `macroSignals` EMPTY_ON_DEMAND, `energyPrices` EMPTY.

   `tests/seed-economy-cron-ttl.test.mjs` pins the cron and derives every bound
   from it. The existing fleet guard could not have caught this: it compares a
   TTL against `maxStaleMin`, and both had drifted together, so `seed-economy`
   sat on its frozen-violations list looking safe. It is off that list now.
3. ~~Find out why the barriers and restrictions fetches reject.~~ **Done
   2026-08-06.** Nothing rejected, and it was not an upstream problem. The
   Worker held no `WTO_API_KEY`. `wtoFetch` returns null before it issues a
   request when that name is unset, so all four WTO branches resolved to null,
   their writes were skipped by the `if (ba)` / `if (re)` guards, and
   `Promise.allSettled` reported every one of them fulfilled — the
   `status === 'rejected'` warning could never print.

   Three layers hid it, and each one masked the next:

   - The seeder partially succeeds. FRED shipping and Treasury customs write,
     so `if (allIndices.length === 0 && !ba && !re) throw` never fires and the
     bundle records `state: "OK"`. That is also why the 2026-08-05 missing-key
     audit never caught it — that audit only looked at seeds writing nothing.
   - Of the four affected key groups, only `tariffTrendsUs` had a health row,
     and it read `EMPTY` (crit) when the truth was "never configured".
   - Barriers and restrictions had no `/api/health` row at all. They appeared
     only in `_standalone-source-thresholds.ts`, which no operator reads.

   The fix routes absence into the `NOT_CONFIGURED` state the repo already has
   rather than inventing a new one. `writeSeedMeta` takes an optional
   `sourceState`; `writeUnavailableSeedMeta` wraps it; the seeder writes
   `{recordCount: 0, sourceState: 'unavailable'}` for all three registered keys
   on every run while the key is missing, and the row flips to OK on its own
   the moment real data lands. Both missing health rows now exist at
   `maxStaleMin: 480`, matching `TRADE_TTL` and clearing the 6-hourly cron.
   `tests/seed-supply-chain-wto-gated.test.mjs` derives every bound from that
   cron and fails if a key joins the gated list without a health row.

   The key arrived the same day. It is installed as the Worker secret
   `WTO_API_KEY` — the name was already on the `SEED_ENV_NAMES` allowlist, so
   no code change was needed to forward it to the container. A local run
   confirmed all three endpoints answer: barriers 50 rows, restrictions 50
   rows, tariff trends 10 datapoints across all 288 reporters.
4. Decide how transit summaries get written now that the Railway relay is gone.
   This is the real port left, and chokepoint status, shipping stress and the
   vessel snapshot all wait on it.

   Decided 2026-08-06. The port splits on one question: does the key need the
   live AIS stream?

   `supply_chain:corridorrisk:v1` does not. `seedCorridorRisk()` in the old
   relay was a plain hourly fetch of corridorrisk.io with a browser user agent,
   mapping six substring patterns onto canonical chokepoint ids. It lived in the
   relay only because that is where the loop ran. It becomes
   `scripts/seed-corridor-risk.mjs`, an ordinary container seed on the hourly
   cron. Porting it first matters: five of the ten fields in every summary row
   (`riskLevel`, `incidentCount7d`, `disruptionPct`, `riskSummary`,
   `riskReportAction`) come from this key and nothing else fills them.

   `supply_chain:transit-summaries:v1`, its thirteen per-chokepoint history
   keys, and `supply_chain:chokepoint_transits:v1` do. The 24-hour crossing
   counts exist in exactly one place: `AisRelayDO`. `worker/ais/vessel-state.ts`
   already records a crossing on exit, after a five-minute dwell and inside a
   thirty-minute per-vessel cooldown, into `chokepointCrossings`, and
   `cleanupAggregates()` already prunes each array to the 24-hour window. That
   machinery was ported with the snapshot and nothing has ever read it —
   `worker/ais/snapshot-contract.ts` carries no transit field.

   So `AisRelayDO.fetch()` gains a `/transits` route beside `/snapshot`, served
   publicly at `/ais/transits` behind the same `isAuthorizedRelayRequest`
   shared-secret gate, and `scripts/seed-transit-summaries.mjs` reads it. A
   container can make that call where the Worker cannot: the 522 recorded
   against `WS_RELAY_URL` above is a Worker fetching its own hostname, and a
   container is a separate network client. It already receives
   `RELAY_SHARED_SECRET` and `RELAY_AUTH_HEADER` — both are on the
   `SEED_ENV_NAMES` allowlist — and every seed starts with `enableInternet:
   true`. `WS_RELAY_URL` is not on that list and has to be added.

   Rejected: recomputing the counts inside the seed from a `/snapshot` read.
   A snapshot is one instant, and a crossing is an entry and an exit separated
   by minutes. Ten-minute polling would miss most of them and count some twice.

   The response reports whether the upstream socket is connected. A disconnected
   relay and a genuinely quiet strait both produce zero crossings, and the
   seeder must not publish the first as the second — on a disconnected read it
   leaves the last good value in place rather than writing zeros.

   One script writes the summary key, the thirteen history keys and
   `chokepoint_transits` with its meta key, through `extraKeys`. The trap
   recorded in `scripts/_seed-utils.mjs` applies: an extraKey `transform`
   receives the raw fetcher output, so a `{ ...data }` spread re-exports what
   `publishTransform` stripped and the run aborts on the leak guard.

   Two details the old code chose deliberately and the port keeps.
   `chokepoint_transits` is keyed by relay geofence name across all fifteen
   fences, including the two that are seas rather than chokepoints; the
   summaries are keyed by canonical id across the thirteen, and the mapping
   between them is the port's job. And `recordCount` on the summary key counts
   the chokepoints PortWatch actually covered, not the always-thirteen row
   count, so `api/health.js` sees a coverage shortfall instead of a full house.

   Left over, now settled: `relay:heartbeat:chokepoint-flows` and
   `relay:heartbeat:climate-news` were health rows the relay wrote and no seed
   ever did. Both are deleted. They caught "the loop fires but its child dies at
   import", a shape that ended when each seeder became its own Cron Trigger and
   container. `chokepointFlows` and `climateNews` each keep their own seed-meta
   freshness row, so nothing lost coverage.

   **Shipped 2026-08-06 in `f368be27a`**, 18 files, +717/-46, on `main`. Four
   suites green in one pass: 20671 data tests, 234 worker, 76 ais-relay, 1320
   server/convex. The seed container image for that commit built and pushed
   (`seeds-4efff5ee933a`), and `wrangler.jsonc` pins it.

   **Deployed 2026-08-06**, version `6e6c1e4f-0006-4c2e-bcdf-3fa7ffcc995e`, all
   39 cron schedules uploaded.

   The open claim is settled: a seed container reaches
   `https://worldmonitor.sibt.ai/ais/transits` and gets an answer. The first
   `*/10` run wrote all three key families — no 522, no direct-to-Durable-Object
   workaround needed. What a container can do here, the Worker still cannot.

   Three things the deploy measured that are worth knowing before the next one.

   **A deploy does not cycle a live Durable Object.** For about a minute after
   `cf-deploy.sh deploy` returned, `/ais/transits` answered 404 while
   `/ais/snapshot` answered 200 — the running `AisRelayDO` was still executing
   the previous code, and 404 is its `fetch()` fallback for an unknown path.
   Retries 20 seconds apart went 404, 200, 200. A 404 on a route added in the
   deploy you just ran is stale-instance lag; retry before reading it as broken
   wiring. Confirming the bundle is cheap either way:
   `cf-deploy.sh deploy --dry-run --outdir <dir>` and grep the emitted JS.

   **A deploy also resets the crossing counts.** `chokepointCrossings` lives in
   Durable Object memory over a rolling 24-hour window, so a new version starts
   at zero and takes a day to refill. Counts read straight after a deploy are
   young, not wrong.

   **`connected: true` with `vessels: 0` is a dead feed, and the first seeded run
   published it.** The guard in `fetchRelayTransits()` threw only on
   `connected !== true`, so zeros went out over the last good counts:
   `transit-summaries:v1` at 13 rows summing to 0, `chokepoint_transits:v1` at 15
   fences summing to 0. The guard now refuses unless the relay also reports at
   least one vessel — a live feed tracks thousands, and a response with no vessel
   count cannot say either way. Refusing through the post-deploy refill window is
   the point of it.

   The zeros themselves come from upstream, and the key is not the reason.
   AISStream accepts the socket and closes it about 700ms after the first inbound
   frame, code 1006, no error frame and no data. Probed from this laptop with the
   `ws` library, five ways: our key with browser headers, our key with none, a
   fabricated 40-character key, an empty key, and malformed JSON that is not a
   subscription at all. All five closed the same way at the same moment. A socket
   that sends nothing survives about 4 seconds and then closes on their
   documented 3-second idle rule, so the connection path works and the message
   handler is what dies. The server never gets as far as reading the key.

   Our key is good. The aisstream.io dashboard shows it created 2026-08-04 and
   `Valid: True`, the value on disk in `.env.local` matches it, and the Worker
   secret `AISSTREAM_API_KEY` is installed. The documented behaviour for a bad
   key is an `"Api Key Is Not Valid"` message on an open socket, which is not
   what the service does now.

   It is a service outage, and other people are reporting it: `aisstream/issues`
   [#257](https://github.com/aisstream/issues/issues/257) (opened 2026-08-05,
   zero messages on a global box, valid key, new key and a second IP all
   affected), [#259](https://github.com/aisstream/issues/issues/259),
   [#261](https://github.com/aisstream/issues/issues/261), and
   `aisstream/aisstream`
   [#32](https://github.com/aisstream/aisstream/issues/32). AISStream is in beta
   with no SLA. Nothing in this repo can fix it and a new key would not help;
   what we do is refuse to publish zeros, which the guard above now does.

   An earlier version of this section read the fabricated-key result backwards
   and called for a new key. Left here on purpose: identical behaviour across a
   real key and a fake one is evidence the key is not being checked, not evidence
   it is bad.

   One thing left standing, recorded rather than fixed: `connected` cannot report
   false. Both `/ais/snapshot` and `/ais/transits` call `connectUpstream()` before
   they read, so every response is built inside the few hundred milliseconds
   before a doomed socket is closed. The field reads as health and measures
   optimism. `vessels` and `messages` are the honest ones.
5. Add the recovered signals to the same pull as they come back. Each one needs
   its own extractor there — the payloads share no shape, so "the consumer does
   not change" was wrong when this list was written. Done for the three trade
   signals on 2026-08-06. What that cost: three path entries, three extractors,
   three fixtures and eight tests in `src/worldmonitor_pull.py` and its test file
   in trade-refresh. Two things the shapes forced, worth knowing before the next
   one: all three answer 200 with an empty list and `upstreamUnavailable: true`
   when their own upstream fails, so a count taken past that flag reads as "no
   barriers today"; and `get-tariff-trends` returns the WTO MFN schedule
   (flat 3.3-3.5% for the United States since 2016) beside duties actually
   collected from FRED/BEA (8.84% for Q2 2026). The gap is the signal. A
   consumer that read the schedule alone would conclude tariffs had not moved
   in a decade.
6. Give autopilot a narrower read: one daily risk number, from the same vault
   doc trade-refresh already writes. Autopilot should not call WorldMonitor
   directly — a second caller means two freshness stories for one figure.
7. The dossier reads the vault doc too, for the same reason.

Steps 6 and 7 are deliberately not integrations. One puller, one document, many
readers. Every extra caller is another thing that can be stale in its own way.
