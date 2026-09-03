// market_implications must survive a self-clearing 429.
//
// The stage passed maxRetries:0 because #5003 reasoned about a two-provider
// chain: retrying a slow primary four times burns the shared 200s run budget
// and strands the fallback. That reasoning does not survive the chain becoming
// one provider. MARKET_IMPLICATIONS_DEFAULT_PROVIDER_ORDER became ['groq'] on
// 2026-08-11 when OpenRouter's free tier went away, so there is no fallback to
// strand — and zero retries means a single HTTP response decides the stage.
//
// groq's free tier is capped per MINUTE, not only per day: measured 2026-08-12,
// x-ratelimit-limit-tokens 12000 with x-ratelimit-reset-tokens 205ms. So a 429
// that clears in a fifth of a second wrote SEED_ERROR for the whole hour, and
// the live seed-meta read `llm_no_response: groq http_429`.
//
// A 429 is already classified retryable and its Retry-After is already honored
// and budget-capped. The only thing defeating all of it was the hardcoded 0.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAndSeedMarketImplications,
  __setRedisStoreForTests,
  __setForecastLlmTransportForTests,
  __setForecastLlmRunDeadlineForTests,
  __setForecastLlmCallOverrideForTests,
  getForecastLlmCallOptions,
  getMarketImplicationsMaxRetries,
} from '../scripts/seed-forecasts.mjs';

const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'GROQ_API_KEY',
  'FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER', 'FORECAST_LLM_PROVIDER_ORDER',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  __setRedisStoreForTests(null);
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
  __setForecastLlmCallOverrideForTests(null);
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

const CARD = {
  ticker: 'LMT', name: 'Lockheed Martin', direction: 'long', timeframe: '1-3m',
  confidence: 0.7, title: 'Defense demand', narrative: 'n', risk_caveat: '',
  driver: '', transmission_chain: [],
};

function seedLastGood(store) {
  store['intelligence:market-implications:v1'] = { cards: [CARD], generatedAt: '2026-07-06T13:00:00.000Z', model: 'prev-model' };
  store['seed-meta:intelligence:market-implications'] = { fetchedAt: 1783340000000, recordCount: 1, status: 'ok' };
}

// No Retry-After header — the shape groq actually returned. The replay then
// waits FORECAST_LLM_RETRY_BASE_MS (1s), which is the real production path and
// is why this test costs a second. A header carrying 0 would be worse than
// useless: createForecastLlmHttpError marks a 0 nonRetryable, so the test would
// pass for the opposite reason.
function rateLimited() {
  return {
    ok: false,
    status: 429,
    headers: { get: () => null },
    json: async () => ({ error: { message: 'rate_limit_exceeded' } }),
    text: async () => 'rate_limit_exceeded',
  };
}

function completion(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content } }], model: 'openai/gpt-oss-120b' }),
    text: async () => content,
  };
}

test('a single-provider chain retries once, a multi-provider chain does not', () => {
  process.env.GROQ_API_KEY = 'test-groq';
  delete process.env.OPENROUTER_API_KEY;
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'groq';
  assert.equal(
    getMarketImplicationsMaxRetries(getForecastLlmCallOptions('market_implications')),
    1,
    'one provider means no fallback to strand, so the stage must be allowed one replay',
  );

  process.env.OPENROUTER_API_KEY = 'test-openrouter';
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter,groq';
  assert.equal(
    getMarketImplicationsMaxRetries(getForecastLlmCallOptions('market_implications')),
    0,
    '#5003 still holds with two providers: fall through to the fallback instead of retrying',
  );
});

test('a 429 on the only provider is replayed instead of writing SEED_ERROR', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);

  process.env.GROQ_API_KEY = 'test-groq';
  delete process.env.OPENROUTER_API_KEY;
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'groq';
  // Plenty of budget: this test is about the retry decision, not the guard.
  __setForecastLlmRunDeadlineForTests(Date.now() + 200_000);

  // The wire shape validateMarketImplications actually accepts, which is NOT the
  // stored shape above: timeframe is one of 1W/2W/1M/3M and confidence is the
  // WORD HIGH/MEDIUM/LOW, not a number. A card that fails validation writes an
  // error meta for a reason that has nothing to do with the retry, so getting
  // this wrong would make the test pass or fail on the wrong thing.
  const payload = JSON.stringify({
    cards: [{
      ticker: 'LMT', name: 'Lockheed Martin', direction: 'long', timeframe: '1M',
      confidence: 'medium', title: 'Fresh read after the replay',
      narrative: 'The retried call returned a usable answer.',
      risk_caveat: '', driver: '', transmission_chain: [],
    }],
  });

  let calls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => {
      calls += 1;
      return calls === 1 ? rateLimited() : completion(payload);
    },
  });
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ result: 1 }), text: async () => '' });

  await buildAndSeedMarketImplications({});

  assert.equal(calls, 2, 'the transient 429 must be replayed — one call means the old hardcoded maxRetries:0');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.notEqual(meta.status, 'error', `a replayed 429 must not write SEED_ERROR (got ${meta.errorReason || meta.status})`);
  assert.equal(
    store['intelligence:market-implications:v1'].cards[0].title,
    'Fresh read after the replay',
    'the successful retry result is what gets published, not the preserved last-good',
  );
});
