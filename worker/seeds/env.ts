/**
 * The environment a seed container is started with.
 *
 * A container inherits nothing from the Worker. `envVars` defaults to `{}`, and
 * Cloudflare's own docs say so plainly: "If you want to provide environment
 * variables to your container at runtime, you should use secret bindings or
 * envVars on the Container class." Measured on the first deploy — seven
 * instances started and every seed hit its own env check, because
 * `getContainer(...).start({ entrypoint, enableInternet })` passed no
 * environment at all.
 *
 * So the names below are forwarded explicitly. The list is an allowlist, not a
 * spread of `env`: a Worker binding is not automatically something a seed
 * script should be able to read, and `WM_SESSION_SECRET` — the session signing
 * key — is the case that proves it. No seed script reads it, and none should.
 *
 * Names may sit here before the Worker holds them. A name with no value is
 * dropped, so listing one early costs nothing and saves a code change when
 * somebody sets the secret.
 */
export const SEED_ENV_NAMES = [
  // Every seed writes through scripts/_seed-utils.mjs to Upstash.
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  // scripts/seed-market-quotes.mjs, seed-economy.mjs, seed-earnings-calendar.mjs.
  'FINNHUB_API_KEY',
  // scripts/seed-digest-notifications.mjs and the user-context helpers.
  'CONVEX_SITE_URL',
  // scripts/_relay-client.mjs reaches the relay with these three.
  // seed-transit-summaries.mjs calls /ais/transits; seed-military-cii.mjs
  // calls /ais/snapshot.
  'RELAY_AUTH_HEADER',
  'RELAY_SHARED_SECRET',
  'WS_RELAY_URL',
  // seed-security-advisories.mjs fetches its RSS feeds directly since
  // 2026-08-09; this is the escape hatch that re-routes them through an
  // external proxy if direct egress gets blocked. Unset today, on purpose.
  'RELAY_URL',
  // The proxy exit the Cross-Strait-Activity section resolves, either name.
  'JAPAN_MOD_PROXY_URL',
  'PROXY_URL',
  // seed-comtrade-bilateral-hs4.mjs runs in public-preview mode without this.
  'COMTRADE_API_KEYS',
  // Third source behind seed-market-quotes.mjs and seed-commodity-quotes.mjs,
  // and the only one for seed-etf-flows.mjs and seed-gulf-quotes.mjs.
  'ALPHA_VANTAGE_API_KEY',
  // seed-internet-outages.mjs reads Cloudflare Radar with it.
  'CLOUDFLARE_API_TOKEN',
  // seed-economic-calendar.mjs, seed-economy.mjs, seed-bls-series.mjs and
  // seed-supply-chain-trade.mjs pull St. Louis Fed series.
  'FRED_API_KEY',

  // ---- listed ahead of the Worker holding them ---------------------------
  // Each name below gates a seed that runs today and writes nothing. The
  // script reaches its env check, throws, and the bundle records a generic
  // failure. None of these values exists yet; a name with no value is
  // dropped, so listing it now costs nothing and means setting the secret is
  // the only step left. Measured 2026-08-05 — see
  // docs/solutions/integration-issues/seed-coverage-gap-after-the-railway-move.md
  'OPENAQ_API_KEY', // seed-health-air-quality.mjs throws without it
  'WAQI_API_KEY', // same script, optional supplement
  'EIA_API_KEY', // seed-eia-petroleum.mjs throws without it
  'UCDP_ACCESS_TOKEN', // seed-ucdp-events.mjs, either name
  'UC_DP_KEY',
  'USPTO_API_KEY', // seed-defense-patents.mjs
  'WTO_API_KEY', // seed-supply-chain-trade.mjs
  'SAM_GOV_API_KEY', // seed-global-tenders.mjs
  'AGSI_API_KEY', // seed-gie-gas-storage.mjs and seed-gas-storage-countries.mjs
  'GIE_API_KEY', // same two scripts, either name
  'ACLED_ACCESS_TOKEN', // seed-conflict-intel.mjs
  'ACLED_EMAIL',
  'ACLED_PASSWORD',
  'RELIEFWEB_APPNAME', // seed-climate-disasters.mjs, seed-climate-news.mjs
  'RELIEFWEB_APP_NAME', // same two scripts, either spelling
  'CLOUDFLARE_R2_ACCOUNT_ID', // seed-military-bases.mjs reads its source from R2
  'CLOUDFLARE_R2_TOKEN',
  'NASA_FIRMS_API_KEY', // seed-fire-detections.mjs reads either name
  'FIRMS_API_KEY',
  // seed-electricity-prices.mjs European half; the EIA half above is keyed and
  // runs without this — the script warns and skips ENTSO-E when it is absent.
  'ENTSO_E_TOKEN',
  // seed-military-flights.mjs OAuth pair (credentials arrived 2026-08-09).
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'WINGBITS_API_KEY', // same script, optional supplement
  'OPENSKY_PROXY_AUTH', // same script, optional proxy exit; falls back to PROXY_URL
  'WINDY_API_KEY', // seed-webcams.mjs (Webcams-product key arrived 2026-08-10)
  // seed-aviation.mjs NOTAM half. Trial key (25 calls, one call per run)
  // arrived 2026-08-09; the script stays UNSCHEDULED until the quota question
  // is settled — its 2h design cadence spends 12 calls a day.
  'ICAO_API_KEY',
  'AVIATIONSTACK_API', // same script's delay half; no key yet
  // seed-bigmac.mjs reads either name, first entry of a comma/newline list.
  // Key borrowed 2026-08-12 from the should-i-be-trading project, which holds
  // a working Exa credential — the traderkit key tried on 2026-08-10 answered
  // X402_PAYMENT_REQUIRED, which is what kept this blocked.
  'EXA_API_KEY',
  'EXA_API_KEYS',
  // seed-grocery-basket, scheduled 2026-08-30. Its retailers use the `search`
  // adapter, which needs BOTH Exa (discovery) and Firecrawl (extraction), so
  // scheduling it without forwarding this name would have produced exactly the
  // failure the test below describes: a seed that runs and writes nothing.
  'FIRECRAWL_API_KEY',
  // Read by the shared helpers, so they reach every seed that imports them.
  'GDELT_PROXY_URL', // scripts/_gdelt-fetch.mjs, its own proxy exit
  'COINGECKO_API_KEY', // scripts/_seed-utils.mjs crypto quotes, either name
  'COINGECKO_DEMO_API_KEY',
  'IMF_API_KEY', // scripts/_seed-utils.mjs IMF series
  'OPENROUTER_API_KEY', // scripts/lib/brief-embedding.mjs
  'GROQ_API_KEY', // scripts/seed-insights.mjs groq fallback in the provider chain
  // seed-insights.mjs cannot run without these two. Its digest source is the
  // gateway's own list-feed-digest cache (TTL 900s), which is always expired
  // by the 30-minute cron tick, so every container run must warm it. Withheld,
  // the warm call goes to the script's default host (the upstream author's
  // api.worldmonitor.app) with no key and takes a 401 — measured 2026-08-09
  // after 88 consecutive INSIGHTS_SYNTHESIS_PROVIDER failures whose provider
  // trail was null: the LLM chain was never reached. The old rationale
  // ("the GitHub fallback carries both and runs it fully") only holds when
  // Cloudflare crons are DOWN — seed-fallback.yml stands down when they are
  // alive, which is exactly when the container starves. WORLDMONITOR_RELAY_KEY
  // is the least-privilege warm credential by design: server/gateway.ts scopes
  // it to RELAY_WARM_PING_PATHS, so its blast radius inside a container is a
  // recompute of public, cacheable data.
  'API_BASE_URL',
  'WORLDMONITOR_RELAY_KEY',
  // scripts/seed-resilience-scores.mjs THROWS without this one:
  // `requireSeedRefreshKey()` is the first thing its main path calls, so the
  // whole Resilience-Scores section died in 671ms on every 6-hourly container
  // tick. Measured 2026-08-24 from the seed-run record:
  // "[Resilience-Scores] FATAL: WORLDMONITOR_SEED_REFRESH_KEY is required for
  // resilience ranking refresh", reason missing_seed_refresh_key, and
  // seed-meta:resilience:intervals 4.2 days old against an 840-minute bound.
  // It sat in SEED_ENV_NOT_FORWARDED below under "no reachable seed needs it",
  // which stopped being true when the resilience bundle joined the registry.
  // Blast radius inside a container is a recompute of the ranking the seed
  // exists to write: server/gateway.ts scopes the key to `refresh=1` on one
  // path, get-resilience-ranking, and nothing else reads it.
  'WORLDMONITOR_SEED_REFRESH_KEY',
] as const;

/**
 * Names a registry-reachable seed reads that stay off the list on purpose.
 *
 * Every other `process.env` read in a reachable script must appear in
 * `SEED_ENV_NAMES` — `tests/worker/seed-env.test.mts` walks the scripts and
 * fails when one does not. This is where an exception is recorded, with the
 * reason, so the guard cannot be quieted by a blanket ignore.
 */
export const SEED_ENV_NOT_FORWARDED: Readonly<Record<string, string>> = {
  // Local switches. A container run is never interactive, so the defaults are
  // the only behaviour we want.
  FORCE_RESEED: 'developer switch for a local re-run',
  IMPORT_HHI_VERBOSE: 'developer switch for local logging',
  COMTRADE_REQUEST_BUDGET: 'developer switch; the script has a default budget',
  RESILIENCE_WHO_MEASLES_INDICATOR: 'developer override for one WHO indicator',
  DIGEST_MAX_STORIES_PER_USER: 'tuning knob; the script has a default',
  FOLLOWED_BIAS_MULTIPLIER: 'tuning knob; the script has a default',
  WM_ALLOW_ENV_LOAD_IN_TESTS: 'test switch, read by scripts/_seed-utils.mjs',
  WM_SEED_ENV_FILE: 'local .env path, meaningless inside a container',
  KEY_PREFIX: 'seed-webcams.mjs key-namespace knob for local runs; empty in production',
  // Set in-process, not inherited.
  BUNDLE_RUN_STARTED_AT_MS: 'scripts/_bundle-runner.mjs sets it per section',
  // The LLM seeds (scheduled 2026-08-07 when OpenRouter/Groq keys arrived).
  // Every name here has a default in the script; only the provider keys
  // themselves are forwarded.
  BRIEF_VALIDATOR_MODE: 'tuning knob; the script has a default',
  OLLAMA_MODEL: 'local-Ollama fallback provider; no Ollama in a container',
  OLLAMA_API_KEY: 'same local fallback',
  IRAN_EVENTS_ENABLED: 'feature flag; the script has a default',
  CHAIN_FORECAST_SEED_ON_MILITARY:
    'feature flag, defaults off; forecasts run on their own cron here',
  GITHUB_SHA: 'CI-injected build metadata, meaningless in a container',
  WM_API_BASE_URL: 'self-call alias of API_BASE_URL, same reason',
  FORECAST_TRACE_MAX_FORECASTS: 'tuning knob; the script has a default',
  FORECAST_LLM_PROVIDER_ORDER: 'tuning knob; the script has a default',
  FORECAST_LLM_COMBINED_PROVIDER_ORDER: 'tuning knob; the script has a default',
  FORECAST_LLM_CRITICAL_PROVIDER_ORDER: 'tuning knob; the script has a default',
  FORECAST_LLM_IMPACT_PROVIDER_ORDER: 'tuning knob; the script has a default',
  FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER: 'tuning knob; the script has a default',
  FORECAST_LLM_COMBINED_MODEL_OPENROUTER: 'model override; the script has a default',
  FORECAST_LLM_MODEL_OPENROUTER: 'model override; the script has a default',
  FORECAST_LLM_CRITICAL_MODEL_OPENROUTER: 'model override; the script has a default',
  FORECAST_LLM_IMPACT_MODEL_OPENROUTER: 'model override; the script has a default',
  FORECAST_LLM_MARKET_IMPLICATIONS_MODEL_OPENROUTER: 'model override; the script has a default',
  USAGE_TELEMETRY: 'developer switch for local logging',
  AXIOM_API_TOKEN: 'observability token for a service this fork does not run',
  FORECAST_PROMOTE_BET_ENGINE: 'feature flag; the script has a default',
  FORECAST_RESOLUTION_JUDGE_MODEL_OPENROUTER: 'model override; the script has a default',
  FORECAST_RESOLUTION_JUDGE_MODEL_GROQ: 'model override; the script has a default',
  // Self-calls. A seed reaching the site it is seeding would loop through the
  // Worker to read what it is about to write. API_BASE_URL and
  // WORLDMONITOR_RELAY_KEY moved OUT of this list 2026-08-09: seed-insights'
  // digest warm is a self-call that produces its input, not an echo of its
  // output — see the entry in SEED_ENV_NAMES.
  WORLDMONITOR_API_KEY:
    'optional repair credential; seed-resilience-scores degrades to a logged skip without it',
  WORLDMONITOR_VALID_KEYS: 'server-side auth list, not a seed input',
};

/**
 * Picks the forwardable environment out of a Worker `env`.
 *
 * A blank value is dropped rather than forwarded: `_bundle-runner.mjs` counts a
 * blank string as missing and skips the section, so passing `""` through would
 * satisfy a presence check with nothing behind it. Non-string bindings (KV
 * namespaces, Durable Object namespaces) are dropped for the same reason.
 */
export function seedEnvVars(env: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const name of SEED_ENV_NAMES) {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') continue;
    vars[name] = value;
  }

  return vars;
}
