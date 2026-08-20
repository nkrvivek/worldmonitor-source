// DeepSeek-Flash routing + completion-timeout policy.
//
// Bug (found 2026-07-14 by probing production): market_implications wrote
// `status:'error' / errorReason:'llm_no_response'` on EVERY hourly run, so
// /api/health sat at SEED_ERROR indefinitely and the homepage panel served
// frozen last-good cards.
//
// Root cause was NOT a slow model — it was a timeout that assumed a pinning
// which was never implemented:
//
//   _llm-model-timeouts.mjs: DEEPSEEK_V4_FLASH_COMPLETION_TIMEOUT_MS = 15_000
//   "Keep it above the pinned endpoint's observed p50"   <-- nothing pinned it
//
// OpenRouter free-routes `deepseek/deepseek-v4-flash` across backends whose
// latency spans an order of magnitude. Measured against production, 12 samples
// of the real market_implications call shape (max_tokens 2500, ~2.3k-token
// prompt):
//
//   Novita / StreamLake / AtlasCloud : 17-28s   (fast)
//   DigitalOcean / GMICloud          : 61-73s
//   NextBit                          : 110s
//   one call                         : >120s, never returned
//
// The FASTEST of those 12 was 17.1s — above the 15s clamp. So the primary
// provider could not succeed even once: 0/12 at 15s. The groq fallback was
// simultaneously 429-ing (free-tier 100k tokens/day, exhausted), hence
// llm_no_response every run.
//
// Fix, measured over 20 samples with `provider: { sort: 'throughput' }`:
//   timeout 15s -> 25%   timeout 25s -> 85%   timeout 40s -> 100%
//
// These tests pin BOTH halves. Either alone is insufficient: routing without a
// workable timeout still guillotines the p90 (26.4s), and a longer timeout
// without routing still lands on NextBit (110s).
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS,
  OPENROUTER_BLOCKED_PROVIDERS,
} from '../scripts/_llm-model-timeouts.mjs';
import {
  getForecastLlmCallOptions,
  resolveForecastLlmProviders,
  getMarketImplicationsMinRunBudgetMs,
  FORECAST_LLM_RUN_BUDGET_MS,
  FORECAST_SEED_LOCK_TTL_MS,
} from '../scripts/seed-forecasts.mjs';

// Observed completion latencies (ms) under the COMPLIANT routing — China-hosted
// providers BLOCKED and throughput-sorted — 14 samples against production.
// Landed on Venice + AtlasCloud only. Blocking costs nothing: this set is FASTER
// than the unrestricted one (which reached p50 17.5s / max 34.7s only by routing to
// novita/streamlake, i.e. by violating the policy).
const MEASURED_THROUGHPUT_ROUTED_MS = [
  16252, 17263, 15944, 10085, 15851, 14360, 22448,
  14739, 14439, 25037, 15281, 14529, 12883, 16408,
];

function coverage(timeoutMs) {
  const ok = MEASURED_THROUGHPUT_ROUTED_MS.filter((ms) => ms <= timeoutMs).length;
  return ok / MEASURED_THROUGHPUT_ROUTED_MS.length;
}

// getMarketImplicationsMinRunBudgetMs key-filters the chain on process.env, and
// the stage/global provider-order envs steer resolution — so both must be
// controlled here, or the reservation silently computes against an empty chain.
const ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'FORECAST_LLM_PROVIDER_ORDER',
  'FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER',
];
let savedEnv = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.GROQ_API_KEY = 'test-groq-key';
  // Production sets this to `openrouter,groq`. market_implications must NOT
  // inherit it — that is the precedence this fix deliberately breaks.
  process.env.FORECAST_LLM_PROVIDER_ORDER = 'openrouter,groq';
  delete process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// These two tests are about the openrouter entry that carries Flash, so they
// select it by name. Reading it off whichever stage happens to resolve to
// openrouter is how they broke when market_implications moved to groq — and a
// version that took providers[0] blindly would have asserted Flash routing
// against the groq entry instead of failing.
function resolveOpenrouterEntry() {
  const providers = resolveForecastLlmProviders(getForecastLlmCallOptions('default'));
  const openrouter = providers.find((provider) => provider.name === 'openrouter');
  assert.ok(openrouter, 'the default chain must still carry the openrouter Flash entry');
  return openrouter;
}

test('the Flash completion timeout clears the measured p90 (the 15s clamp made the primary impossible)', () => {
  // The old 15s clamp sat BELOW the fastest observed completion for this call
  // shape, so no amount of retrying could ever succeed.
  assert.ok(
    DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS > Math.min(...MEASURED_THROUGHPUT_ROUTED_MS),
    'timeout must exceed the FASTEST observed completion, or the primary can never succeed',
  );
  // The user's bar: succeed 90%+ of the time.
  assert.ok(
    coverage(DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS) >= 0.9,
    `timeout ${DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS}ms only covers `
      + `${(coverage(DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS) * 100).toFixed(0)}% of measured runs; need >=90%`,
  );
});

test('the provider-level timeout does not re-clamp Flash below its completion budget', () => {
  // getLlmAttemptTimeoutMs takes min(providerTimeout, flashCap). A provider
  // timeout below the cap silently reinstates the bug, which is exactly what
  // the old 25s provider timeout did to a 40s cap.
  const openrouter = resolveOpenrouterEntry();
  assert.equal(
    openrouter.timeout,
    DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS,
    'the effective attempt timeout must equal the Flash cap, not a lower provider timeout',
  );
  assert.ok(coverage(openrouter.timeout) >= 0.9);
});

test('Flash is pinned to fast backends — the timeout policy assumes routing that must actually exist', () => {
  const openrouter = resolveOpenrouterEntry();
  // Without this, OpenRouter free-routes to NextBit (110s) / DigitalOcean (73s)
  // and NO timeout under ~120s is reliable.
  assert.equal(
    openrouter.extraBody?.provider?.sort,
    'throughput',
    'openrouter must request throughput-sorted routing so the latency tail is bounded',
  );
  // The seeder MUST carry the same China-hosted-provider blocklist as the server
  // client. Throughput-sorting WITHOUT it routes WorldMonitor's geopolitical
  // prompts straight onto the blocked providers, because they are the fastest —
  // the policy and the speed fix pull in opposite directions, so they must ship
  // together. This is the regression that nearly shipped.
  assert.deepEqual(
    openrouter.extraBody?.provider?.ignore,
    OPENROUTER_BLOCKED_PROVIDERS,
    'seeder routing must apply the shared China-hosted provider blocklist',
  );
  // The reasoning:false pin must survive the change (Flash emits reasoning
  // tokens otherwise, inflating latency and cost for no benefit).
  assert.equal(openrouter.extraBody?.reasoning?.enabled, false);
});

test('market_implications resolves to exactly one provider', () => {
  // The stage runs LAST, inside the seed lock, on the shared run budget, so its
  // admission reservation is the sum of the chain's timeouts. A two-provider
  // chain reserves 65s to buy a second attempt from a provider that fails in
  // under 100ms — that raises the admission bar and starves the stage. One
  // provider is the invariant; which one is a live-availability call.
  //
  // Back to openrouter 2026-08-12: the user added credits, and the live key now
  // reports is_free_tier false with credit remaining while a v4-flash completion
  // answers 200 — so the 402 that forced the groq stopgap on 2026-08-11 is gone.
  // Groq stays off the chain: its free tier binds per MINUTE (measured 12000
  // tokens with a 205ms reset) on top of the 100k/day cap this stage's ~114k
  // would exceed, so it 429s often and would cost 20s of reservation to do it.
  const providers = resolveForecastLlmProviders(getForecastLlmCallOptions('market_implications'));
  assert.deepEqual(providers.map((p) => p.name), ['openrouter']);
});

test('the market_implications admission reservation covers exactly its own chain', () => {
  // market_implications runs LAST (afterPublish) on the SAME run budget as every
  // upstream stage, and afterPublish is INSIDE the seed lock — so the tail cannot
  // simply be handed its own budget without risking a lock overrun.
  //
  // A single-provider chain is what keeps this affordable: the reservation is the
  // sum of the resolved chain's timeouts + guard. A two-provider chain would
  // reserve 40+20+5 = 65s of run budget to buy a second attempt from a provider
  // that fails in under 100ms, raising the admission bar (=> MORE starvation) for
  // nothing. The stage runs on groq, so the reservation is groq's own timeout.
  const [only, ...rest] = resolveForecastLlmProviders(getForecastLlmCallOptions('market_implications'));
  assert.deepEqual(rest, [], 'the reservation only stays small while the chain is one provider');
  const reservation = getMarketImplicationsMinRunBudgetMs(getForecastLlmCallOptions('market_implications'));
  assert.equal(reservation, only.timeout + 5_000, 'one attempt + guard only');
  assert.ok(
    reservation <= DEEPSEEK_V4_FLASH_LONG_COMPLETION_TIMEOUT_MS + 5_000,
    'the tail must not reserve more than the Flash chain it replaced',
  );
});

test('the run budget leaves the tail its reservation, and still fits inside the seed lock', () => {
  // Two invariants that must move together. Raising the Flash timeout makes upstream
  // stages actually COMPLETE (~20s) instead of dying at 15s, so they consume more of
  // the shared run budget — the tail needs headroom, but the whole run must still
  // finish inside the lock or a slow run gets its lock stolen mid-write.
  const reservation = getMarketImplicationsMinRunBudgetMs(getForecastLlmCallOptions('market_implications'));

  // Upstream would have to burn (200s - 45s) = 155s to starve the tail. Throughput-
  // routed stages are p90 26s / capped at 40s, so this cannot happen in practice.
  assert.ok(
    FORECAST_LLM_RUN_BUDGET_MS - reservation >= 150_000,
    'run budget must leave upstream ample room while still preserving the tail reservation',
  );
  // The run budget must stay strictly under the lock, with cleanup headroom.
  assert.ok(
    FORECAST_LLM_RUN_BUDGET_MS < FORECAST_SEED_LOCK_TTL_MS,
    'LLM run budget must not be able to outlive the seed lock',
  );
  assert.ok(
    FORECAST_SEED_LOCK_TTL_MS - FORECAST_LLM_RUN_BUDGET_MS >= 30_000,
    'leave >=30s of lock headroom for non-LLM work, publish and cleanup',
  );
});
