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
 *   three threat feed keys, seed-forecasts and seed-bundle-regional want an LLM
 *   provider (GROQ_API_KEY or OPENROUTER_API_KEY). They would start, find
 *   nothing, and write nothing.
 * - The rest of the credential-blocked group, measured 2026-08-05 by mapping
 *   every no-cron health check to the script that writes its seed-meta key:
 *   seed-consumer-prices (CONSUMER_PRICES_CORE_API_KEY and its base URL — six
 *   checks plus seven per-country slices), seed-aviation (AVIATIONSTACK_API,
 *   ICAO_API_KEY), seed-electricity-prices (ENTSO_E_TOKEN — it also reads
 *   EIA_API_KEY, which is set now, but the European half still has nothing),
 *   seed-bigmac and seed-grocery-basket (EXA_API_KEY, and FIRECRAWL_API_KEY for
 *   the basket), seed-webcams (WINDY_API_KEY), seed-military-flights
 *   (OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET, WINGBITS_API_KEY) and
 *   seed-forecast-resolutions, which needs the same LLM provider as
 *   seed-forecasts to judge a resolution.
 * - seed-military-cii and seed-security-advisories. Both read RELAY_URL, which
 *   defaults to proxy.worldmonitor.app — a host this fork does not run. The
 *   Worker serves /ais/snapshot and /ais/transits, so the AIS half of
 *   seed-military-cii would work, but its advisory half would not, and it warns
 *   and skips instead of failing: a cron would cost a run and write nothing.
 *   seed-transit-summaries reads /ais/transits and is scheduled below.
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
  { cron: '*/10 * * * *', scripts: ['scripts/seed-transit-summaries.mjs'] },

  // ---- every 15 minutes ---------------------------------------------------
  {
    cron: '*/15 * * * *',
    scripts: [
      'scripts/seed-conflict-intel.mjs',
      'scripts/seed-gdelt-bulk-materializer.mjs',
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
  {
    cron: '0 6 * * *',
    scripts: ['scripts/seed-bundle-resilience-energy-v2.mjs'],
  },
  { cron: '30 7 * * *', scripts: ['scripts/seed-bundle-energy-sources.mjs'] },
  { cron: '0 8 * * *', scripts: ['scripts/seed-bundle-macro.mjs'] },
  // FRED_TTL is 93600 — "26h — survive daily cron scheduling drift", so daily.
  { cron: '0 9 * * *', scripts: ['scripts/seed-economy.mjs'] },
  { cron: '0 13 * * *', scripts: ['scripts/seed-bundle-ecb-eu.mjs'] },
  // After the US close, which is what the breadth numbers describe.
  { cron: '0 23 * * *', scripts: ['scripts/seed-market-breadth.mjs'] },

  // ---- weekly -------------------------------------------------------------
  { cron: '0 3 * * SUN', scripts: ['scripts/seed-bundle-static-ref.mjs'] },
  // CACHE_TTL is 864000 — "10 days — weekly seed with 3-day cron-drift buffer".
  { cron: '0 10 * * SUN', scripts: ['scripts/seed-fuel-prices.mjs'] },
  // The CFTC publishes Friday afternoon; Saturday picks it up.
  { cron: '0 5 * * SAT', scripts: ['scripts/seed-cot.mjs'] },
  // AAII publishes Thursday.
  { cron: '0 12 * * THU', scripts: ['scripts/seed-aaii-sentiment.mjs'] },

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
