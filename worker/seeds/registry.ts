/**
 * Which seed scripts each Cron Trigger runs.
 *
 * Deliberately free of Cloudflare imports: tests/worker/seed-registry.test.mts
 * loads this under plain Node. The workerd-only code lives in
 * worker/seeds/scheduled.ts.
 *
 * Where the schedules come from, in order of authority:
 *
 * 1. scripts/railway-services.json, for the nine services whose `cronSchedule`
 *    was read back from the Railway API. Those expressions are copied exactly.
 * 2. docs/railway-seed-consolidation-runbook.md, which records a verified cron
 *    for each bundle and an inferred cadence for the seeds added after its
 *    snapshot.
 * 3. The seed's own cache TTL, whose comment states the interval it was sized
 *    for — seed-earthquakes.mjs says "6h — 6x the 1h cron interval", so it runs
 *    hourly.
 *
 * Minutes are staggered where the cadence allows it. Railway gave every service
 * its own box, so a dozen jobs at `0 * * * *` cost nothing; here each script is
 * a container instance, and max_instances caps how many run at once. Same
 * cadence, spread across the hour. The peak-overlap test holds the ceiling.
 *
 * Not here, and why:
 * - Seeds that need a key the Worker does not hold. seed-cyber-threats wants
 *   three threat feed keys. (seed-forecasts, seed-insights,
 *   seed-forecast-resolutions and seed-bundle-regional sat here for the same
 *   reason until 2026-08-07, when the user supplied OpenRouter and Groq keys —
 *   they are scheduled below now.)
 * - The rest of the credential-blocked group, measured 2026-08-05 by mapping
 *   every no-cron health check to the script that writes its seed-meta key:
 *   seed-consumer-prices (CONSUMER_PRICES_CORE_API_KEY and its base URL — six
 *   checks plus seven per-country slices), seed-aviation (AVIATIONSTACK_API
 *   arrived 2026-08-10 but the key is the free tier — 100 calls/mo against
 *   ~55 calls per refresh; user chose to stay free, so it stays unscheduled.
 *   ICAO_API_KEY same posture: trial quota), seed-grocery-basket, which needs
 *   FIRECRAWL_API_KEY on top of the Exa key and holds no Firecrawl credential
 *   (seed-bigmac left this group 2026-08-12: the traderkit Exa key that
 *   answered X402_PAYMENT_REQUIRED on 2026-08-10 was replaced by the working
 *   should-i-be-trading one, and bigmac needs nothing else — it is scheduled
 *   on the Sunday price tick below) and
 *   seed-forecast-resolutions, which needs the same LLM provider as
 *   seed-forecasts to judge a resolution. (seed-military-flights left this
 *   group 2026-08-09 when the OpenSky OAuth pair arrived; seed-electricity-
 *   prices the same day — its EIA half was never blocked, and the ENTSO-E half
 *   skips with a warn until ENTSO_E_TOKEN is set. Both are scheduled below.
 *   seed-webcams left 2026-08-10 when the Windy Webcams-product key arrived —
 *   scheduled below.)
 * - (seed-military-cii and seed-security-advisories left this group
 *   2026-08-09. The advisories script now fetches its feeds directly and
 *   treats RELAY_URL as an unset escape hatch; military-cii reads the
 *   Worker's own /ais/snapshot through WS_RELAY_URL. Both are scheduled
 *   below, alongside the new seed-shipping-stress and seed-usni-fleet ports
 *   from the dead Railway relay.)
 * - seed-forecast-bets. A shadow engine gated behind FORECAST_BETS_ENSEMBLE=1
 *   that never writes the user-facing forecast:predictions:v2 key.
 * - seed-bundle-resilience-validation. Its Sensitivity-Suite member imports
 *   server/*.ts at runtime, so it needs the tsx loader that
 *   Dockerfile.seed-bundle-resilience-validation installs and Dockerfile.seeds
 *   does not.
 * - Bundle members. A bundle spawns its own, so a second trigger runs them
 *   twice.
 * - digest-notifications, publish-bootstrap-tiers and relay, each its own port.
 */
export type SeedJob = {
  readonly cron: string;
  readonly scripts: readonly string[];
};

export const SEED_JOBS: readonly SeedJob[] = [
  // ---- every 5 minutes ----------------------------------------------------
  {
    cron: '*/5 * * * *',
    scripts: [
      'scripts/seed-bundle-derived-signals.mjs',
      'scripts/seed-bundle-market-backup.mjs',
    ],
  },

  // ---- every 10 minutes ---------------------------------------------------
  // The relay ran this one every 10 minutes and its key carries a 1h TTL sized
  // at "6x the interval". maxStaleMin is 30, so anything slower reports stale.
  {
    cron: '*/10 * * * *',
    scripts: [
      'scripts/seed-transit-summaries.mjs',
      // Joined 2026-08-09 with the OpenSky OAuth pair. maxStaleMin is 30
      // (LIVE_TTL 600s), which this cadence is sized against. Wingbits stays
      // optional — the script skips that source without its key.
      'scripts/seed-military-flights.mjs',
      // Joined 2026-08-09. Health maxStaleMin is 45; it reads the flights key
      // the script above just wrote plus the Worker's own /ais/snapshot, so it
      // runs in the same tick, after them. While AISStream is out the vessel
      // half warns and the flights half still writes.
      'scripts/seed-military-cii.mjs',
    ],
  },

  // ---- every 15 minutes ---------------------------------------------------
  {
    cron: '*/15 * * * *',
    scripts: [
      'scripts/seed-conflict-intel.mjs',
      'scripts/seed-gdelt-bulk-materializer.mjs',
      // Ported 2026-08-09 from the dead Railway relay, which ran it every
      // 15 minutes. Health maxStaleMin is 45; the 1h TTL is sized 4x this.
      'scripts/seed-shipping-stress.mjs',
      // The relay's 8-minute warm loop, ported 2026-08-10. warm-ping.yml
      // carries the same six warms on a GitHub cron, but GitHub skips —
      // 00:38Z to 03:01Z measured — and riskScores went EMPTY inside its
      // 45-minute bound. This rail fires dependably; the workflow stays as
      // backup, and the warms are idempotent.
      'scripts/seed-warm-ping.mjs',
    ],
  },
  // 15m cache TTL, so the alerts key expires without a run this often.
  { cron: '5,20,35,50 * * * *', scripts: ['scripts/seed-weather-alerts.mjs'] },

  // ---- every 30 minutes ---------------------------------------------------
  // Both carry a 3h TTL sized at "6x the 30 min cron interval".
  {
    cron: '3,33 * * * *',
    scripts: [
      'scripts/seed-internet-outages.mjs',
      'scripts/seed-prediction-markets.mjs',
    ],
  },
  // 30m TTL each.
  {
    cron: '11,41 * * * *',
    scripts: [
      'scripts/seed-market-quotes.mjs',
      'scripts/seed-commodity-quotes.mjs',
    ],
  },
  // Joined 2026-08-07 with the LLM keys. CACHE_TTL comment: "3h — 6x the
  // 30 min cron interval". Its digest warm self-call needs
  // WORLDMONITOR_RELAY_KEY + API_BASE_URL, forwarded since 2026-08-09
  // (worker/seeds/env.ts). The earlier "the GitHub fallback carries both"
  // design starved in steady state: the digest cache TTL (900s) is always
  // expired at the tick, and seed-fallback.yml stands down whenever CF crons
  // are alive — 88 consecutive PROVIDER failures before the env fix.
  { cron: '7,37 * * * *', scripts: ['scripts/seed-insights.mjs'] },
  // seed-unrest-events is sized for 45 min; 30 keeps it inside its TTL.
  {
    cron: '18,48 * * * *',
    scripts: [
      'scripts/seed-unrest-events.mjs',
      'scripts/seed-bundle-relay-backup.mjs',
    ],
  },

  // ---- hourly -------------------------------------------------------------
  { cron: '0 */1 * * *', scripts: ['scripts/seed-bundle-portwatch.mjs'] },
  // Joined 2026-08-07, the day an LLM key first existed here (user-supplied
  // OpenRouter + Groq). TTL 6h "6x the 1h cron interval", health maxStaleMin
  // 90 — hourly is what both were written for.
  { cron: '13 * * * *', scripts: ['scripts/seed-forecasts.mjs'] },
  {
    cron: '25 * * * *',
    scripts: [
      'scripts/seed-earthquakes.mjs',
      'scripts/seed-crypto-sectors.mjs',
    ],
  },
  {
    cron: '40 * * * *',
    scripts: [
      'scripts/seed-radiation-watch.mjs',
      'scripts/seed-bundle-health.mjs',
    ],
  },
  // 2h TTL, deliberately short so a dead feed reports EMPTY rather than serving
  // yesterday's fires, and a 40 min lock sized for "27 slots × ~72s worst
  // case … Next cron tick sees lock held and safely skips". Hourly is what both
  // numbers were written for. A live run took 180s for 32,322 detections.
  // Minute 8 is otherwise empty; the run is the longest in the hourly group.
  { cron: '8 * * * *', scripts: ['scripts/seed-fire-detections.mjs'] },
  // 4h TTL and maxStaleMin 120, so hourly leaves room for a missed run. Minute
  // 45 puts it five minutes ahead of the :50 transit-summaries tick, which
  // reads the risk fields it writes.
  { cron: '45 * * * *', scripts: ['scripts/seed-corridor-risk.mjs'] },
  // Joined 2026-08-09, direct-fetch default (the relay-proxy leg became an
  // unset RELAY_URL escape hatch). Health maxStaleMin is 120, so hourly
  // leaves room for a missed run. Minute 52 is otherwise empty.
  { cron: '52 * * * *', scripts: ['scripts/seed-security-advisories.mjs'] },

  // ---- every 2 hours ------------------------------------------------------
  // 6h TTL on a regulator RSS sweep.
  { cron: '50 */2 * * *', scripts: ['scripts/seed-regulatory-actions.mjs'] },

  // ---- every 3 hours ------------------------------------------------------
  {
    cron: '15 */3 * * *',
    scripts: [
      'scripts/seed-bundle-climate.mjs',
      'scripts/seed-thermal-escalation.mjs',
    ],
  },

  // ---- every 6 hours ------------------------------------------------------
  { cron: '0 */6 * * *', scripts: ['scripts/seed-supply-chain-trade.mjs'] },
  // Ported 2026-08-09 from the dead Railway relay, which ran it every 6h.
  // 24h TTL against health maxStaleMin 720 (the relay's 12h equalled the gate,
  // which turns a late run into an EMPTY crit); USNI publishes weekly, so
  // most runs re-confirm the same report. Minute 10 keeps the slot to itself.
  { cron: '10 */6 * * *', scripts: ['scripts/seed-usni-fleet.mjs'] },
  {
    cron: '20 */6 * * *',
    scripts: [
      'scripts/seed-bundle-resilience.mjs',
      'scripts/seed-fear-greed.mjs',
    ],
  },
  {
    cron: '35 */6 * * *',
    scripts: [
      'scripts/seed-energy-intelligence.mjs',
      'scripts/seed-research.mjs',
    ],
  },
  // Reads three keys and holds no credential of its own: supply_chain:portwatch
  // and portwatch:disruptions:active from seed-bundle-portwatch (hourly), and
  // energy:chokepoint-baselines from seed-bundle-static-ref (Sunday 03:00,
  // which has not fired here yet — first chance 2026-08-09). Its own TTL
  // comment sizes the cadence: "3d — upstream seeder runs every 6h".
  { cron: '55 */6 * * *', scripts: ['scripts/seed-chokepoint-flows.mjs'] },
  // seed-energy-spine reads what the other energy seeds wrote, so it runs last.
  {
    cron: '50 */6 * * *',
    scripts: [
      'scripts/seed-sanctions-pressure.mjs',
      'scripts/seed-energy-spine.mjs',
    ],
  },

  // ---- every 12 hours -----------------------------------------------------
  {
    cron: '0 */12 * * *',
    scripts: ['scripts/seed-bundle-portwatch-port-activity.mjs'],
  },
  // Both carry a 36h TTL, "3× a 12h cron interval".
  {
    cron: '30 */12 * * *',
    scripts: [
      'scripts/seed-earnings-calendar.mjs',
      'scripts/seed-economic-calendar.mjs',
    ],
  },
  // GEO_TTL 24h = 2× this cadence; health maxStaleMin 1440 on
  // seed-meta:webcam:cameras:geo. ~127 Windy calls per run (top-1050 by
  // popularity per region past the API's offset ceiling), measured 2026-08-10.
  { cron: '45 */12 * * *', scripts: ['scripts/seed-webcams.mjs'] },

  // ---- daily --------------------------------------------------------------
  // 25h TTL: "covers daily cron with 1h drift buffer".
  {
    cron: '0 2 * * *',
    scripts: ['scripts/seed-fx-rates.mjs', 'scripts/seed-fx-yoy.mjs'],
  },
  // 72h TTL, "3× daily interval".
  { cron: '0 3 * * *', scripts: ['scripts/seed-trade-flows.mjs'] },
  { cron: '0 4 * * *', scripts: ['scripts/seed-ember-electricity.mjs'] },
  // 30h TTL.
  { cron: '0 5 * * *', scripts: ['scripts/seed-hormuz.mjs'] },
  // Joined 2026-08-07 with the LLM keys. Health maxStaleMin 2160 — "daily
  // Bet-2 resolver; 36h catches a missed cron without flapping".
  { cron: '30 5 * * *', scripts: ['scripts/seed-forecast-resolutions.mjs'] },
  {
    cron: '0 6 * * *',
    scripts: ['scripts/seed-bundle-resilience-energy-v2.mjs'],
  },
  { cron: '30 7 * * *', scripts: ['scripts/seed-bundle-energy-sources.mjs'] },
  { cron: '0 8 * * *', scripts: ['scripts/seed-bundle-macro.mjs'] },
  // FRED_TTL is 93600 — "26h — survive daily cron scheduling drift", so daily.
  { cron: '0 9 * * *', scripts: ['scripts/seed-economy.mjs'] },
  // REDIS_TTL 172800 — "48h", header says "Cadence: daily". No credentials
  // beyond Redis; the script lost its schedule in the Railway cutover and
  // intelligence:gpsjam:v2 sat empty until 2026-08-09.
  { cron: '0 11 * * *', scripts: ['scripts/fetch-gpsjam.mjs'] },
  { cron: '0 13 * * *', scripts: ['scripts/seed-bundle-ecb-eu.mjs'] },
  // ENTSO-E publishes day-ahead auction results ~12:42 CET; 14:00 UTC clears
  // that in both DST states. The health row (electricityPrices) allows 2880min
  // = 2x this daily cadence. The EIA half runs on its key alone; the ENTSO-E
  // half joins when ENTSO_E_TOKEN is set and skips with a warn until then.
  { cron: '0 14 * * *', scripts: ['scripts/seed-electricity-prices.mjs'] },
  // After the US close, which is what the breadth numbers describe.
  { cron: '0 23 * * *', scripts: ['scripts/seed-market-breadth.mjs'] },

  // ---- weekly -------------------------------------------------------------
  { cron: '0 3 * * SUN', scripts: ['scripts/seed-bundle-static-ref.mjs'] },
  // CACHE_TTL is 864000 — "10 days — weekly seed with 3-day cron-drift buffer".
  // seed-bigmac joined this tick 2026-08-12 rather than taking a cron of its
  // own: the Big Mac index moves about once a year, one Exa search per run is
  // the whole cost, and reusing a live expression keeps wrangler.jsonc's cron
  // list unchanged. Both are price series, so a shared bundle reads honestly.
  {
    cron: '0 10 * * SUN',
    scripts: ['scripts/seed-fuel-prices.mjs', 'scripts/seed-bigmac.mjs'],
  },
  // The CFTC publishes Friday afternoon; Saturday picks it up.
  { cron: '0 5 * * SAT', scripts: ['scripts/seed-cot.mjs'] },
  // AAII publishes Thursday.
  { cron: '0 12 * * THU', scripts: ['scripts/seed-aaii-sentiment.mjs'] },
  // Joined 2026-08-07 with the LLM keys. Snapshots inside it are already on
  // the 6h derived-signals bundle; this weekly tick exists for the LLM brief
  // section, which self-gates at 6.5 days and needs OPENROUTER/GROQ.
  { cron: '45 5 * * SUN', scripts: ['scripts/seed-bundle-regional.mjs'] },

  // ---- monthly ------------------------------------------------------------
  {
    cron: '0 4 1 * *',
    scripts: ['scripts/seed-bundle-resilience-recovery.mjs'],
  },
  { cron: '0 6 1 * *', scripts: ['scripts/seed-comtrade-bilateral-hs4.mjs'] },
  // Derived from the bilateral HS4 flows, so it runs the day after.
  {
    cron: '0 7 2 * *',
    scripts: ['scripts/seed-hs2-chokepoint-exposure.mjs'],
  },
  // The IMF publishes on its own calendar; the bundle's own 30-day gate decides
  // whether a run does any work, so the date only has to be clear of the two
  // above.
  { cron: '0 8 3 * *', scripts: ['scripts/seed-bundle-imf-extended.mjs'] },
];

export function scriptsForCron(cron: string): readonly string[] {
  return SEED_JOBS.find((job) => job.cron === cron)?.scripts ?? [];
}
