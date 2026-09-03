#!/usr/bin/env node

import {
  loadEnvFile,
  CHROME_UA,
  getRedisCredentials,
  runSeed,
  withRetry,
  httpRetryError,
  createLlmBudgetError,
  extendExistingTtl,
  isLlmBudgetError,
  readExistingSeedMeta,
  writeExtraKey,
} from './_seed-utils.mjs';
import {
  clusterItems,
  computeEntityCorroboration,
  selectTopStories,
  DIPLOMACY_KEYWORDS,
  ENTITY_BIGRAMS,
} from './_clustering.mjs';
import { extractCountryCode } from './shared/geo-extract.mjs';
import { buildChinaNewsCoverage } from './_china-news-coverage.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import {
  pickBriefCluster,
  briefSystemPrompt,
  briefUserPrompt,
  synthesisSystemPrompt,
  synthesisUserPrompt,
  parseBriefSynthesis,
  BRIEF_REJECT_RULES,
  composeSynthesizedBrief,
} from './_insights-brief.mjs';
import { buildLlmCallEvent, emitLlmEvents, flushPendingLlmEvents } from './lib/llm-telemetry.cjs';
// Import from the scripts mirror (`scripts/shared/`) — NOT the repo-root
// `shared/`. Railway services with nixpacks `rootDirectory=scripts` only
// package files under scripts/; a `../shared/` import resolves to
// `/shared/...` at runtime which is absent in the container and crashes
// the seeder on startup. The local pattern is the `./shared/geo-extract.mjs`
// line above. PR #3836 review caught this. See skill
// railway-deploy-gotchas/reference/nixpacks-root-dir-scripts-cross-dir-import-escape.
import { validateNoHallucinatedProperNouns } from './shared/brief-llm-core.js';
import { GROQ_FALLBACK_MODEL, GROQ_EXTRA_BODY } from './lib/groq-model.mjs';

// Hallucination validator rollout mode (PR-2 of brief-content-quality
// regressions). `shadow` = log violations to Sentry but ship the LLM
// output unchanged (default, safe). `enforce` = on violation, replace
// the LLM summary with the source headline. Flip via Railway env after
// the 7-day shadow window confirms <5% violation rate.
// #4921: enforce is the DEFAULT — the shadow window measured its
// false-positive rate; shipping detected hallucinations was the residual
// risk. Set BRIEF_VALIDATOR_MODE=shadow to revert during an incident.
const BRIEF_VALIDATOR_MODE =
  process.env.BRIEF_VALIDATOR_MODE === 'shadow' ? 'shadow' : 'enforce';

// True only when run directly as a cron entry (node seed-insights.mjs), false
// when imported by tests — so importing the module doesn't load .env or fire a
// live seed. Mirrors seed-forecasts.mjs.
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (_isDirectRun) loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'news:insights:v1';
const DIGEST_KEY = 'news:digest:v1:full:en';
const CHINA_COVERAGE_KEY = 'news:insights:v1:CN';
const CHINA_NEWS_DIGEST_LANGUAGE = 'zh';

// The exact string cachedFetchJson writes when a builder returns nothing, so
// the next 120 seconds of callers back off instead of re-running it. See
// NEG_SENTINEL in server/_shared/redis.ts; setCachedJson JSON-encodes whatever
// it is handed, so the value lands in Redis as a quoted string.
//
// Measured 2026-08-19: the seeds read Redis directly rather than through
// cachedFetchJson, which is the only place that knows to treat this as a miss.
// So a sentinel arrived here as a perfectly truthy string, sailed past the
// `if (!digest)` guard, and died three retries later on `Digest has no items
// (shape: string)` — a hard SEED_ERROR standing in for "the RSS builder found
// zero items just now". The distinction is the whole point: absent means the
// warm path or the RPC is broken, negative-cached means upstream news is
// empty and there is nothing here to fix.
const NEG_SENTINEL = '__WM_NEG__';

// Returned in place of a digest when Redis holds the negative sentinel. A
// distinct frozen marker rather than null, so the caller can tell the two
// apart without a second read, and so readOrWarmDigest does NOT warm: the
// sentinel means the builder ran moments ago and produced nothing, and
// re-warming it is precisely the request storm the sentinel exists to absorb.
export const DIGEST_NEGATIVE_CACHED = Object.freeze({ negativeCached: true });

// The retry ladder fetchInsights climbs when a digest read comes back
// negative-cached. Sized against the TWO sentinels a negative can be
// (server/_shared/redis.ts cachedFetchJson, gateway list-feed-digest.ts):
//
//   - A COLD build exceeds DIGEST_RESPONSE_TIMEOUT_MS (14s), the fetcher
//     times out, and a 30s error sentinel is armed while the late build's
//     result is discarded. The 45s first rung clears that TTL while the
//     isolate the failed build warmed is still warm — a warm build measures
//     ~12s and fits the timeout.
//   - A build that COMPLETES with zero items arms the 120s sentinel. The
//     second rung puts the ladder's total past that window.
//
// Why a ladder and not one long wait — measured 2026-08-26, twice. Five
// overnight ticks each read back a sentinel while manual runs MINUTES later
// (01:46Z, 05:16Z — inside the 300s per-feed empty window) got 233 and 74
// items, so the per-feed caches were never the constraint. A single 330s
// retry shipped on that wrong theory failed its first live trial the same
// night: 5.5 idle minutes guaranteed a cold isolate, which timed out exactly
// like the first read. Three negatives across ~3 minutes is a real supply
// outage and still reports as negative-cached.
export const DIGEST_NEGATIVE_RETRY_WAITS_MS = Object.freeze([45_000, 135_000]);

// runSeed's fetch deadline is lockTtlMs + 120s margin, and the default 120s
// lock gave a 240s deadline the first retry attempt blew (measured
// 2026-08-26: "news:insights fetch phase exceeded 240000ms deadline"). 600s
// covers the full ladder plus digest polls around every rung plus LLM
// synthesis, and stays well inside the 30-minute cron cadence.
export const INSIGHTS_LOCK_TTL_MS = 600_000;

/**
 * Read the digest, climbing the retry ladder while reads come back
 * negative-cached. `read` is the readOrWarmDigest thunk; `sleep` is
 * injectable for tests.
 */
export async function readDigestRetryingNegative(read, { sleep } = {}) {
  const doSleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let result = await read();
  for (const waitMs of DIGEST_NEGATIVE_RETRY_WAITS_MS) {
    if (result !== DIGEST_NEGATIVE_CACHED) return result;
    console.log(
      `  Digest negative-cached — waiting ${waitMs / 1000}s for its sentinel to lapse, then retrying...`,
    );
    await doSleep(waitMs);
    result = await read();
  }
  return result;
}

// Defense-in-depth auth — see seed-infra.mjs for the same pattern + rationale.
// Set WORLDMONITOR_RELAY_KEY on the Railway service (must match a value in
// Vercel's WORLDMONITOR_VALID_KEYS). Origin alone is no longer reliable
// because CF/Vercel intermediaries may strip it and CF can cache the 401.
const RELAY_API_KEY = process.env.WORLDMONITOR_RELAY_KEY || '';

// Digest items store proto enum strings (THREAT_LEVEL_HIGH etc.) from toProtoItem().
// Normalize to client-side lowercase values before propagating into insights output.
const PROTO_TO_LEVEL = {
  THREAT_LEVEL_CRITICAL: 'critical',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_UNSPECIFIED: 'info',
};

function normalizeThreat(threat) {
  if (!threat) return undefined;
  const level = PROTO_TO_LEVEL[threat.level] ?? threat.level;
  return { ...threat, level };
}

const CACHE_TTL = 10800; // 3h — 6x the 30 min cron interval. Shorter = key expires on any missed
                         // cron tick and /api/bootstrap loses insights entirely. Bad brief content
                         // is gated at brief-selection time (see pickBriefCluster + briefSystemPrompt
                         // in _insights-brief.mjs), not by aging out fast.
const MAX_HEADLINE_LEN = 500;
const INSIGHTS_SOURCE_VERSION = 'digest-clustering-v2-importance-diversity';
const INSIGHTS_MAX_CONSECUTIVE_FAILURES = 100;
const INSIGHTS_RUN_OUTCOMES = Object.freeze({
  LKG_PRESERVED: 'lkg_preserved',
  PUBLISHED: 'published',
  DEGRADED: 'degraded',
});

// These codes are intentionally low-cardinality and safe to put in seed-meta,
// health responses, and logs. Never include prompt or model output text in the
// rejection diagnostic: the payload may contain sensitive intelligence.
export const INSIGHTS_SYNTHESIS_FAILURE_CODES = Object.freeze({
  PARSE: 'INSIGHTS_SYNTHESIS_PARSE',
  GATE: 'INSIGHTS_SYNTHESIS_GATE',
  MISSING_CLUSTER: 'INSIGHTS_SYNTHESIS_MISSING_CLUSTER',
  PROVIDER: 'INSIGHTS_SYNTHESIS_PROVIDER',
  // The digest never arrived, so no provider was ever called. Distinct from
  // PROVIDER on purpose: 88 consecutive failures wore that label 2026-08-09
  // while the real fault was an unauthenticated warm call to the wrong host —
  // a null provider trail beside a provider failure code is what finally gave
  // it away. An input-availability failure must not impersonate an LLM one.
  DIGEST_MISSING: 'INSIGHTS_SYNTHESIS_DIGEST_MISSING',
  // Upstream had no items and said so. Separate from DIGEST_MISSING because the
  // operator action differs: this one is not ours to fix, and a run of them is a
  // news-supply reading, not a broken warm path.
  DIGEST_NEGATIVE_CACHED: 'INSIGHTS_SYNTHESIS_DIGEST_NEGATIVE_CACHED',
});
const INSIGHTS_SYNTHESIS_FAILURE_CODE_SET = new Set(Object.values(INSIGHTS_SYNTHESIS_FAILURE_CODES));
const BRIEF_REJECT_RULE_SET = new Set(BRIEF_REJECT_RULES);
const INSIGHTS_RUN_META = Symbol('worldmonitor.insightsRunMeta');

function normalizeInsightsFailureCode(code) {
  return INSIGHTS_SYNTHESIS_FAILURE_CODE_SET.has(code)
    ? code
    : INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER;
}

/**
 * The failure code says which STAGE rejected; the rule says which editorial
 * test inside the gate did. GATE covered eight distinct rules with one word,
 * so an operator reading the alarm could not tell a model that invented a
 * proper noun from a gate that had become impossible to satisfy — the two need
 * opposite fixes. The rule name was written to container logs only, which is
 * not where anyone reads an alarm from.
 *
 * An unrecognized value normalizes to null rather than to a default rule. A
 * wrong rule name is worse than no rule name: it sends the reader at a test
 * that did not fire.
 */
function normalizeInsightsRejectRule(rule) {
  return BRIEF_REJECT_RULE_SET.has(rule) ? rule : null;
}

function attachInsightsRunMeta(payload, runMeta) {
  const decorated = { ...(payload || {}) };
  Object.defineProperty(decorated, INSIGHTS_RUN_META, {
    value: Object.freeze({ ...(runMeta || {}) }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return decorated;
}

/**
 * Attach non-serialized run state to an insights payload. The marker lets the
 * runSeed validation seam distinguish a true LKG preservation from a fresh
 * payload without ever writing the marker to Redis.
 */
export function decorateInsightsRun(payload, runMeta) {
  return attachInsightsRunMeta(payload, runMeta);
}

function insightsRunMeta(payload) {
  return payload?.[INSIGHTS_RUN_META] || null;
}

/**
 * Strip audit-only China coverage while retaining the non-serialized run
 * marker for validation and afterPublish hooks.
 */
export function publishInsightsPayload(data) {
  const { chinaNewsCoverage: _chinaNewsCoverage, ...payload } = data || {};
  const runMeta = insightsRunMeta(data);
  return runMeta ? attachInsightsRunMeta(payload, runMeta) : payload;
}

export function validateInsightsPayload(data) {
  if (insightsRunMeta(data)?.outcome === INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED) return false;
  return declareRecords(data) > 0;
}

/**
 * Keep synthesis rejection telemetry bounded and machine-actionable. The
 * classifier deliberately accepts only stage outcomes, never raw prompt or
 * provider text, so this value is safe for seed-meta, health, and logs.
 */
export function classifyInsightsSynthesisFailure({
  hasBriefCluster = false,
  synthesisResult = null,
  parsedSynthesis = null,
  composed = null,
} = {}) {
  if (composed) return null;
  if (!hasBriefCluster) return INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER;
  if (!synthesisResult) return INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER;
  if (!parsedSynthesis) return INSIGHTS_SYNTHESIS_FAILURE_CODES.PARSE;
  return INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE;
}

export function resolveInsightsFallbackStatus({ synthesisFailureCode, legacyStatus }) {
  return synthesisFailureCode ? 'degraded' : legacyStatus;
}

/**
 * #5947: how many corroborated (brief-eligible) clusters the corpus held on
 * this run. Bounded and numeric so it is safe for seed-meta/health/logs, and
 * it is the field that separates the two very different worlds behind a
 * MISSING_CLUSTER rejection: 0 means the corpus genuinely had nothing to lead
 * with (legitimately degraded), while >0 means selection failed to surface a
 * cluster that existed — the production incident this issue tracked. Absent
 * stats normalize to null, never 0, so a telemetry failure cannot impersonate
 * a bare corpus.
 */
const INSIGHTS_MAX_BRIEF_ELIGIBLE_CLUSTERS = 1000;

function normalizeBriefEligibleClusters(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return Math.min(INSIGHTS_MAX_BRIEF_ELIGIBLE_CLUSTERS, value);
}

/**
 * Build only the diagnostic patch owned by the insights seeder. `fetchedAt`
 * remains under runSeed's control: on a rejected LKG attempt it is mirrored
 * from the old canonical envelope, while a successful publish gets `now`.
 */
export function buildInsightsFreshnessMetaPatch({
  previousMeta,
  outcome,
  failureCode = null,
  rejectRule = null,
  nowMs = Date.now(),
  servedGeneratedAt = null,
  briefEligibleClusters = null,
  providerOutcomes = null,
} = {}) {
  const previous = previousMeta && typeof previousMeta === 'object' ? previousMeta : {};
  const now = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) : Date.now();
  const previousFailures = Number.isInteger(previous.consecutiveFailures) && previous.consecutiveFailures > 0
    ? previous.consecutiveFailures
    : 0;
  const servedAt = typeof servedGeneratedAt === 'string' && servedGeneratedAt.length <= 64
    ? servedGeneratedAt
    : (typeof previous.servedGeneratedAt === 'string' ? previous.servedGeneratedAt : null);
  const normalizedFailureCode = failureCode == null ? null : normalizeInsightsFailureCode(failureCode);
  // Vocabulary-only, same contract as the failure code: an unknown rule is
  // dropped, never defaulted. See normalizeInsightsRejectRule.
  const normalizedRejectRule = normalizeInsightsRejectRule(rejectRule);
  const eligibleClusters = normalizeBriefEligibleClusters(briefEligibleClusters);
  // Attempt trail, bounded and vocabulary-only (see recordLlmProviderOutcome).
  // 256 chars caps even a full 24-entry trail; anything non-string drops out.
  const outcomesTrail = typeof providerOutcomes === 'string' && providerOutcomes.length > 0
    ? providerOutcomes.slice(0, 256)
    : null;

  if (outcome === INSIGHTS_RUN_OUTCOMES.PUBLISHED) {
    return {
      lastAttemptAt: now,
      lastSuccessAt: now,
      servedGeneratedAt: servedAt,
      consecutiveFailures: 0,
      lastSynthesisFailureCode: normalizedFailureCode,
      lastSynthesisRejectRule: null,
      briefEligibleClusters: eligibleClusters,
      lastSynthesisProviderOutcomes: outcomesTrail,
    };
  }

  return {
    lastAttemptAt: now,
    lastSuccessAt: Number.isFinite(previous.lastSuccessAt) ? previous.lastSuccessAt : null,
    servedGeneratedAt: servedAt,
    consecutiveFailures: Math.min(INSIGHTS_MAX_CONSECUTIVE_FAILURES, previousFailures + 1),
    lastSynthesisFailureCode: normalizedFailureCode || INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER,
    lastSynthesisRejectRule: normalizedRejectRule,
    briefEligibleClusters: eligibleClusters,
    lastSynthesisProviderOutcomes: outcomesTrail,
  };
}

const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here)|first[, ]+(i|we|let)|to summarize (the headlines|the task|this)|my task (is|was|:)|step \d)/i;
const PROMPT_ECHO = /^(summarize the top story|summarize the key|rules:|here are the rules|the top story is likely)/i;

function stripReasoningPreamble(text) {
  const trimmed = text.trim();
  if (TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed)) {
    const lines = trimmed.split('\n').filter(l => l.trim());
    const clean = lines.filter(l => !TASK_NARRATION.test(l.trim()) && !PROMPT_ECHO.test(l.trim()));
    return clean.join('\n').trim() || trimmed;
  }
  return trimmed;
}

function sanitizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, MAX_HEADLINE_LEN)
    .trim();
}

function clipText(value, maxLen) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

function normalizeBriefSourceUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizePublishedAt(value) {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function briefSourceFromStory(story) {
  const url = normalizeBriefSourceUrl(story?.primaryLink);
  const title = clipText(story?.primaryTitle, 160);
  const source = clipText(story?.primarySource, 80);
  if (!url || !title || !source) return null;
  const publishedAt = normalizePublishedAt(story?.pubDate);
  return publishedAt ? { title, source, url, publishedAt } : { title, source, url };
}

/**
 * #4928: the legacy single-headline brief, extracted intact from the main
 * flow (L2 of the fallback chain). Corroboration-gated via
 * pickBriefCluster; enforce/shadow semantics unchanged.
 */
async function generateLegacySingleHeadlineBrief(topStories, { callBudgetMs } = {}) {
  const briefCluster = pickBriefCluster(topStories);
  const topHeadline = briefCluster ? sanitizeTitle(briefCluster.primaryTitle) : '';
  const worldBriefSources = briefCluster ? [briefSourceFromStory(briefCluster)].filter(Boolean) : [];

  if (!topHeadline) {
    console.warn('  No multi-source cluster available — publishing degraded (stories without brief)');
    return { worldBrief: '', briefProvider: '', briefModel: '', worldBriefSources, status: 'degraded' };
  }

  const llmResult = await callLLM(topHeadline, Number.isFinite(callBudgetMs) ? { callBudgetMs } : {});
  if (!llmResult) {
    console.warn('  No LLM available — publishing degraded (stories without brief)');
    return { worldBrief: '', briefProvider: '', briefModel: '', worldBriefSources, status: 'degraded' };
  }

  // Hallucination check: did the LLM invent proper nouns not in the
  // headline? (May 19 incident: "Lebanese President Michel Aoun pledged…"
  // against a nameless headline. docs/plans/2026-05-19-001 U2.)
  const validation = validateNoHallucinatedProperNouns(llmResult.text, topHeadline);
  if (!validation.ok) {
    const hallucinated = (validation.hallucinated || []).join(' ');
    if (BRIEF_VALIDATOR_MODE === 'enforce') {
      console.warn(`  [brief_hallucination ENFORCE] dropped LLM summary: invented "${hallucinated}" not in headline; fell back to headline`);
      return {
        worldBrief: topHeadline,
        briefProvider: `${llmResult.provider}+headline-fallback`,
        briefModel: llmResult.model,
        worldBriefSources,
        status: 'ok',
      };
    }
    console.warn(`  [brief_hallucination SHADOW] would have dropped LLM summary: invented "${hallucinated}" not in headline`);
  }
  return {
    worldBrief: llmResult.text,
    briefProvider: llmResult.provider,
    briefModel: llmResult.model,
    worldBriefSources,
    status: 'ok',
  };
}

function digestKeyForLanguage(language) {
  return `news:digest:v1:full:${language}`;
}

// Read one cached digest and say which of the three states it is in: a usable
// digest, the negative sentinel, or nothing. Exported so the regression test
// can drive all three without a Redis.
export function interpretDigestPayload(raw) {
  if (raw == null) return null;
  const value = unwrapEnvelope(raw).data;
  if (value === NEG_SENTINEL) return DIGEST_NEGATIVE_CACHED;
  // Anything that is not an object is not a digest. Returning null here sends
  // the caller down the last-known-good path instead of letting a stray scalar
  // reach the shape check and fail the whole seed.
  if (typeof value !== 'object' || value === null) return null;
  return value;
}

async function readDigestFromRedis(key = DIGEST_KEY) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? interpretDigestPayload(JSON.parse(data.result)) : null;
}

async function readExistingInsights() {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(CANONICAL_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

// Provider config — mirrors server/_shared/llm.ts getProviderCredentials()
// Order: ollama → openrouter → groq (canonical chain since #4944: DeepSeek
// V4 Flash primary with reasoning disabled, groq 70B free-tier fallback)
const LLM_PROVIDERS = [
  {
    name: 'ollama',
    envKey: 'OLLAMA_API_URL',
    apiUrlFn: (baseUrl) => new URL('/v1/chat/completions', baseUrl).toString(),
    model: () => process.env.OLLAMA_MODEL || 'llama3.1:8b',
    headers: (_key) => {
      const h = { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA };
      const apiKey = process.env.OLLAMA_API_KEY;
      if (apiKey) h.Authorization = `Bearer ${apiKey}`;
      return h;
    },
    extraBody: { think: false },
    timeout: 25_000,
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'deepseek/deepseek-v4-flash',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': CHROME_UA }),
    // OpenRouter picks a different upstream per call and the spread is routing,
    // not work. Measured 2026-08-13 on the real 1881-char synthesis prompt, all
    // returning ~300 completion tokens: Novita 2865ms, SiliconFlow 4265ms,
    // GMICloud 4618ms, DigitalOcean 24042ms, and one cold call at 46937ms.
    // `sort: 'throughput'` asks for the fast route rather than paying for the
    // slow one; the timeout below covers the slow route when we get it anyway.
    extraBody: { reasoning: { enabled: false }, provider: { sort: 'throughput' } },
    timeout: 30_000,
  },
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: GROQ_FALLBACK_MODEL,
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA }),
    extraBody: GROQ_EXTRA_BODY,
    timeout: 15_000,
  },
];

// Bounded retry for the brief LLM call. seed-insights holds a 120s seed lock,
// and since #6001 a run may walk the whole provider chain for L1 and then make
// a second callLLM for the L2 fallback — so the budget below is threaded as a
// RUN-level remainder (see fetchInsights) rather than spent twice. Honor a
// provider's Retry-After (429/503) instead of dropping straight to the next
// provider, but never sleep/fetch past the remaining call budget.
const INSIGHTS_LLM_MAX_RETRIES = 2;
const INSIGHTS_LLM_RETRY_BASE_MS = 1_000;
const INSIGHTS_LLM_RETRY_AFTER_MAX_MS = 10_000;
// The budget has to cover a first attempt at EVERY provider, or the chain
// starves the last one: `usableBudgetMs()` caps each signal at what is left, so
// a provider reached with nothing remaining aborts in milliseconds and logs
// "aborted due to timeout" — indistinguishable from an upstream that is merely
// slow. At 60_000 the three timeouts (25s + 30s + 15s) already summed past the
// 55s usable, so a configured ollama could silently cost us groq. Guarded by
// tests/insights-llm-provider-budget.test.mjs. Still well inside the 120s seed
// lock: the non-LLM half of a live run measures ~16s.
const INSIGHTS_LLM_CALL_BUDGET_MS = 80_000;
const INSIGHTS_LLM_CALL_BUDGET_GUARD_MS = 5_000;

// Bounded per-run trail of provider attempts ("openrouter:timeout;groq:http_401").
// Values come from the same low-cardinality reason vocabulary as llm_call
// telemetry, never raw provider text, so the trail is safe for seed-meta. A
// container run has no other channel for this: stdout stays inside the
// container and the Axiom sink is not configured on this fork.
const MAX_LLM_PROVIDER_OUTCOMES = 24;
const llmProviderOutcomes = [];

function recordLlmProviderOutcome(provider, outcome) {
  if (llmProviderOutcomes.length >= MAX_LLM_PROVIDER_OUTCOMES) return;
  llmProviderOutcomes.push(`${provider}:${outcome}`);
}

export function insightsProviderOutcomesTrail() {
  return llmProviderOutcomes.length ? llmProviderOutcomes.join(';') : null;
}

let insightsLlmFetchForTests = null;
function __setInsightsLlmTransportForTests(overrides = null) {
  insightsLlmFetchForTests = typeof overrides?.fetch === 'function' ? overrides.fetch : null;
}

async function callLLM(headline, options = {}) {
  // #4921: callers may supply explicit prompts (the top-8 synthesis call);
  // the headline default keeps the legacy single-headline path and its
  // retry tests unchanged.
  const systemPrompt = options.systemPrompt
    ?? briefSystemPrompt(new Date().toISOString().split('T')[0]);
  const userPrompt = options.userPrompt ?? briefUserPrompt(headline);
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 300;

  const insightsFetch = insightsLlmFetchForTests || ((...args) => globalThis.fetch(...args));
  const callBudgetMs = Number.isFinite(options.callBudgetMs)
    ? Math.max(0, Math.floor(options.callBudgetMs))
    : INSIGHTS_LLM_CALL_BUDGET_MS;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, Math.floor(options.retryDelayMs))
    : INSIGHTS_LLM_RETRY_BASE_MS;
  const budgetStartedAtMs = Date.now();
  const usableBudgetMs = () => Math.max(0, budgetStartedAtMs + callBudgetMs - Date.now() - INSIGHTS_LLM_CALL_BUDGET_GUARD_MS);

  // llm_call telemetry (#4944 U5): one event per provider OUTCOME (the
  // withRetry duration covers in-provider retries), unified with the
  // Vercel-side stream via scripts/lib/llm-telemetry.cjs.
  const promptChars = (systemPrompt?.length ?? 0) + (userPrompt?.length ?? 0);
  const events = [];
  let attemptIndex = 0;

  // #6001: the chain used to fall through on TRANSPORT failures only. A model
  // that reliably returns well-formed text the brief composer then rejects on
  // its editorial gates would strand the run on `degraded` forever without
  // ever trying a fallback model that passes — measured against a live digest,
  // the primary composed 2/6 while the fallback composed 6/6, yet only the
  // primary was ever asked. `accept` lets the caller veto a response and keep
  // the chain moving. When every provider is vetoed we return the LAST
  // response rather than null, so the caller still classifies the failure by
  // its real stage (parse/gate) instead of mislabelling it a provider outage.
  // Keep the FIRST rejection, not the last: the caller classifies the failure
  // stage from this response, and the primary model's stage is the actionable
  // one. A candidate whose acceptor THREW is held separately and only used if
  // nothing was cleanly rejected — handing back text the caller's own gate
  // chokes on would just move the fault downstream.
  const accept = typeof options.accept === 'function' ? options.accept : null;
  let firstRejected = null;
  let firstFaulted = null;
  const rejectedResult = () => firstRejected ?? firstFaulted;

  for (const provider of LLM_PROVIDERS) {
    const envVal = process.env[provider.envKey];
    if (!envVal) {
      // The one state the reason vocabulary cannot otherwise show: the
      // credential never reached this environment at all.
      recordLlmProviderOutcome(provider.name, 'skipped_no_key');
      continue;
    }

    const apiUrl = provider.apiUrlFn ? provider.apiUrlFn(envVal) : provider.apiUrl;
    const model = typeof provider.model === 'function' ? provider.model() : provider.model;
    const t0 = Date.now();
    const record = (ok, extra = {}) => {
      recordLlmProviderOutcome(provider.name, ok ? 'ok' : (extra.reason || 'unknown'));
      events.push(buildLlmCallEvent({
        provider: provider.name, model, stage: 'seed-insights', ok,
        durationMs: Date.now() - t0, promptChars, maxTokens,
        fallbackIndex: attemptIndex++,
        ...extra,
      }));
    };

    try {
      const resp = await withRetry(async () => {
        const usable = usableBudgetMs();
        if (usable <= 0) throw createLlmBudgetError('insights llm budget exhausted');
        const response = await insightsFetch(apiUrl, {
          method: 'POST',
          headers: provider.headers(envVal),
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: maxTokens,
            temperature: 0.1,
            ...provider.extraBody,
          }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(provider.timeout, usable))),
        });
        if (!response.ok) {
          throw httpRetryError(response, { maxRetryAfterMs: INSIGHTS_LLM_RETRY_AFTER_MAX_MS, capMs: usableBudgetMs() });
        }
        return response;
      }, INSIGHTS_LLM_MAX_RETRIES, retryDelayMs);

      const json = await resp.json();
      const usage = {
        tokensTotal: json.usage?.total_tokens ?? 0,
        tokensPrompt: json.usage?.prompt_tokens ?? 0,
        tokensCompletion: json.usage?.completion_tokens ?? 0,
      };
      const rawText = json.choices?.[0]?.message?.content?.trim();
      if (!rawText) {
        console.warn(`  ${provider.name}: empty response`);
        record(false, { ...usage, reason: 'empty' });
        continue;
      }

      const text = stripReasoningPreamble(rawText)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
        .replace(/<think>[\s\S]*/gi, '')
        .trim();

      if (text.length < 20) {
        console.warn(`  ${provider.name}: output too short (${text.length} chars)`);
        record(false, { ...usage, reason: 'too_short' });
        continue;
      }

      const candidate = { text, model: json.model || model, provider: provider.name };

      if (accept) {
        let accepted = null;
        let faulted = false;
        try {
          accepted = accept(text);
        } catch (acceptErr) {
          // A faulty acceptor must never mark unvalidated output as good.
          faulted = true;
          console.warn(`  ${provider.name}: output acceptor threw (${acceptErr.message})`);
        }
        if (!accepted) {
          if (!faulted) console.warn(`  ${provider.name}: output rejected by caller gates`);
          // `validate_reject` is the shared vocabulary from server/_shared/usage.ts,
          // so these unify with the Vercel-side llm_call stream in one query.
          record(false, { ...usage, model: json.model || model, reason: 'validate_reject' });
          if (faulted) { if (!firstFaulted) firstFaulted = candidate; }
          else if (!firstRejected) firstRejected = candidate;
          continue;
        }
      }

      record(true, { ...usage, model: json.model || model });
      void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
      return candidate;
    } catch (err) {
      console.warn(`  ${provider.name} failed: ${err.message}`);
      const httpMatch = /HTTP (\d{3})/.exec(err.message || '');
      record(false, {
        reason: isLlmBudgetError(err) ? 'budget_exhausted'
          : err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout'
          : httpMatch ? `http_${httpMatch[1]}`
          : 'fetch_error',
      });
      // Budget spent — give up rather than burning the next provider's timeout.
      if (isLlmBudgetError(err)) {
        void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
        return rejectedResult();
      }
    }
  }

  void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
  return rejectedResult();
}

function categorizeStory(title) {
  const lower = (title || '').toLowerCase();
  const categories = [
    { keywords: ['war', 'attack', 'missile', 'troops', 'airstrike', 'combat', 'military'], cat: 'conflict', threat: 'critical' },
    { keywords: ['killed', 'dead', 'casualties', 'massacre', 'shooting'], cat: 'violence', threat: 'high' },
    { keywords: ['protest', 'uprising', 'riot', 'unrest', 'coup'], cat: 'unrest', threat: 'high' },
    { keywords: ['sanctions', 'tensions', 'escalation', 'threat'], cat: 'geopolitical', threat: 'elevated' },
    { keywords: ['crisis', 'emergency', 'disaster', 'collapse'], cat: 'crisis', threat: 'high' },
    { keywords: ['earthquake', 'flood', 'hurricane', 'wildfire', 'tsunami'], cat: 'natural_disaster', threat: 'elevated' },
    { keywords: ['election', 'vote', 'parliament', 'legislation'], cat: 'political', threat: 'moderate' },
    { keywords: ['market', 'economy', 'trade', 'tariff', 'inflation'], cat: 'economic', threat: 'moderate' },
  ];

  for (const { keywords, cat, threat } of categories) {
    if (keywords.some(kw => lower.includes(kw))) {
      return { category: cat, threatLevel: threat };
    }
  }
  return { category: 'general', threatLevel: 'moderate' };
}

function normalizedSignalText(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clusterHasDiplomacySignal(cluster) {
  const titles = Array.isArray(cluster.memberTitles) && cluster.memberTitles.length > 0
    ? cluster.memberTitles
    : [cluster.primaryTitle];
  return titles.some((title) => {
    const text = normalizedSignalText(title);
    return DIPLOMACY_KEYWORDS.some((kw) => text.includes(kw)) ||
      ENTITY_BIGRAMS.some(([entity, action]) => text.includes(entity) && text.includes(action));
  });
}

function percentile(sortedNumbers, pct) {
  if (sortedNumbers.length === 0) return 0;
  const idx = Math.min(sortedNumbers.length - 1, Math.floor((sortedNumbers.length - 1) * pct));
  return sortedNumbers[idx];
}

function buildImportanceObservability(clusters, topStories) {
  const clusterSizes = clusters.map(c => Number(c.sourceCount) || 1).sort((a, b) => a - b);
  return {
    llmDrivenRanked: topStories.filter(s => s.threat?.source === 'llm').length,
    keywordFallbackRanked: topStories.filter(s => s.threat?.source !== 'llm' && !s.upstreamImportanceScore).length,
    diplomacyHits: clusters.filter(clusterHasDiplomacySignal).length,
    corroborationHits: clusters.filter(c => c.entityCorroboration === true).length,
    clusterSizeP50: percentile(clusterSizes, 0.5),
    clusterSizeP90: percentile(clusterSizes, 0.9),
  };
}

async function warmDigestCache(language = 'en') {
  const apiBase = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
  const headers = {
    'User-Agent': CHROME_UA,
    Origin: 'https://worldmonitor.app',
  };
  if (RELAY_API_KEY) headers['X-WorldMonitor-Key'] = RELAY_API_KEY;
  try {
    const resp = await fetch(`${apiBase}/api/news/v1/list-feed-digest?variant=full&lang=${encodeURIComponent(language)}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.ok) console.log(`  ${language} digest cache warmed via RPC`);
    else {
      const keyNote = RELAY_API_KEY ? '' : ' (WORLDMONITOR_RELAY_KEY not set — Origin-only auth)';
      console.warn(`  Digest warm failed: HTTP ${resp.status}${keyNote}`);
    }
  } catch (err) {
    console.warn(`  Digest warm failed: ${err.message}`);
  }
}

async function readOrWarmDigest(language) {
  const key = digestKeyForLanguage(language);
  let digest = await readDigestFromRedis(key);
  if (digest) return digest;
  console.log(`  ${language} digest not in Redis, warming cache via RPC...`);
  await warmDigestCache(language);
  // The gateway awaits its Redis write before responding, so one readback
  // after a 200 warm should hit. The poll covers the other outcomes — a
  // degraded build, a concurrent warm-ping landing late — where a single
  // fixed 3s sleep read back nothing and sent the run down the LKG path.
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, 3_000));
    digest = await readDigestFromRedis(key);
    if (digest) return digest;
  }
  return digest;
}

async function readChinaNewsDigest() {
  try {
    const digest = await readOrWarmDigest(CHINA_NEWS_DIGEST_LANGUAGE);
    // A negative sentinel is not per-source evidence. Report it as absent so the
    // coverage projection records "no zh digest" rather than carrying a marker
    // object into the audit trail.
    return digest === DIGEST_NEGATIVE_CACHED ? null : digest;
  } catch (err) {
    // China-source coverage must degrade independently. A Redis or Edge
    // failure for the supplemental locale digest must not suppress the global
    // insights payload that the existing English path can still publish.
    console.warn(`  ${CHINA_NEWS_DIGEST_LANGUAGE} digest coverage check failed: ${err.message}`);
    return null;
  }
}

// A degraded global brief may reuse the last known-good public payload even
// though this run obtained fresh per-source digest evidence. Keep that audit
// projection attached for afterPublish; publishTransform still prevents it
// from entering the public insights cache.
export function preserveChinaNewsCoverageInLkg(existing, chinaNewsCoverage) {
  return chinaNewsCoverage ? { ...existing, chinaNewsCoverage } : existing;
}

async function fetchInsights() {
  const digest = await readDigestRetryingNegative(() => readOrWarmDigest('en'));
  if (digest === DIGEST_NEGATIVE_CACHED) {
    // Upstream produced zero items within the last two minutes and cached that
    // refusal. Serve the last known good brief rather than failing the seed:
    // there is no fault here to fix, and a hard failure would spend three
    // retries re-asking a question upstream has already answered.
    const existing = await readExistingInsights();
    if (existing?.topStories?.length) {
      console.log('  Digest negative-cached upstream — reusing existing insights (LKG)');
      return decorateInsightsRun(existing, {
        outcome: INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED,
        failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.DIGEST_NEGATIVE_CACHED,
      });
    }
    throw new Error('News digest is negative-cached upstream and no prior insights exist');
  }
  if (!digest) {
    // LKG fallback: reuse existing insights if digest is unavailable
    const existing = await readExistingInsights();
    if (existing?.topStories?.length) {
      console.log('  Digest unavailable — reusing existing insights (LKG)');
      return decorateInsightsRun(existing, {
        outcome: INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED,
        failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.DIGEST_MISSING,
      });
    }
    throw new Error('No news digest found in Redis');
  }

  // The global top-eight list is intentionally rank-limited and cannot prove
  // that a China source completed. Preserve the digest's per-feed outcome as
  // a compact, audit-only projection before the global ranking can discard it.
  const chinaNewsCoverage = buildChinaNewsCoverage({
    en: digest,
    [CHINA_NEWS_DIGEST_LANGUAGE]: await readChinaNewsDigest(),
  });

  // Digest shape: { categories: { politics: { items: [...] }, ... }, feedStatuses, generatedAt }
  let items;
  if (Array.isArray(digest)) {
    items = digest;
  } else if (digest.categories && typeof digest.categories === 'object') {
    items = [];
    for (const bucket of Object.values(digest.categories)) {
      if (Array.isArray(bucket.items)) items.push(...bucket.items);
    }
  } else {
    items = digest.items || digest.articles || digest.headlines || [];
  }

  if (items.length === 0) {
    const keys = typeof digest === 'object' && digest !== null ? Object.keys(digest).join(', ') : typeof digest;
    throw new Error(`Digest has no items (shape: ${keys})`);
  }

  console.log(`  Digest items: ${items.length}`);

  const normalizedItems = items.map(item => ({
    title: sanitizeTitle(item.title || item.headline || ''),
    source: item.source || item.feed || '',
    link: item.link || item.url || '',
    pubDate: item.pubDate || item.publishedAt || item.date || new Date().toISOString(),
    isAlert: item.isAlert || false,
    tier: item.tier,
    threat: normalizeThreat(item.threat),
    importanceScore: item.importanceScore,
    corroborationCount: item.corroborationCount ?? item.storyMeta?.sourceCount,
    storyMeta: item.storyMeta,
  })).filter(item => item.title.length > 10);

  const clusters = clusterItems(normalizedItems);
  console.log(`  Clusters: ${clusters.length}`);

  // #4920 coverage ledger: capture what the selection gates dropped.
  const selectionStats = {};
  const topStories = selectTopStories(clusters, 8, selectionStats);
  console.log(`  Top stories: ${topStories.length}`);
  const observability = buildImportanceObservability(clusters, topStories);
  console.log(
    `  Importance signals: llm=${observability.llmDrivenRanked} ` +
      `keywordFallback=${observability.keywordFallbackRanked} ` +
      `diplomacy=${observability.diplomacyHits} ` +
      `entityCorroboration=${observability.corroborationHits} ` +
      `clusterSizeP50=${observability.clusterSizeP50} ` +
      `clusterSizeP90=${observability.clusterSizeP90}`,
  );

  if (topStories.length === 0) throw new Error('No top stories after scoring');

  // Corroboration gate: only brief a story at least two outlets have reported.
  // See pickBriefCluster() in _insights-brief.mjs for rationale + unit tests.
  // Note: this gates ONLY brief generation — the topStories payload itself
  // continues to include single-source clusters, rendered as the headline list
  // under the brief. The brief paragraph is the one surface where corroboration
  // matters; the list is already visually marked with per-story sourceCount.
  // #4921/#4928: L1 = top-8 synthesis via the pure composer (parse +
  // corroboration gate + lead noun/anchor gates + per-line enforcement +
  // citation verification + index-locked sources — all unit-tested in
  // _insights-brief.mjs). L2 = legacy single-headline brief. Degraded last.
  // The brief always ships.
  let worldBrief = '';
  let briefProvider = '';
  let briefModel = '';
  let briefStoryLines = [];
  let worldBriefSources = [];
  let status = 'ok';
  let synthesisFailureCode = null;
  let synthesisRejectRule = null;

  const briefCluster = pickBriefCluster(topStories);
  const hasBriefCluster = briefCluster != null;
  // #5947: a MISSING_CLUSTER rejection is only legitimate when the corpus had
  // nothing corroborated to lead with. Log the corpus count (and whether the
  // reservation had to fire) so a recurrence is diagnosable from the run log
  // and seed-meta alone.
  // Do NOT default to 0 here: 0 is the meaningful value "the corpus had nothing
  // corroborated to lead with". Substituting it for absent stats would make a
  // telemetry failure read exactly like a benign bare-corpus run.
  const briefEligibleClusters = typeof selectionStats.briefEligibleConsidered === 'number'
    ? selectionStats.briefEligibleConsidered
    : null;
  if (selectionStats.briefEligiblePromoted) {
    console.log(
      `  Brief lead reserved: promoted a corroborated cluster into top-${topStories.length} ` +
        `(${briefEligibleClusters ?? 'unknown'} eligible in corpus, source=${briefCluster?.primarySource ?? 'unknown'})`,
    );
  } else if (!hasBriefCluster) {
    console.warn(`  [brief_synthesis] no corroborated cluster in corpus (eligible=${briefEligibleClusters ?? 'unknown'})`);
  }
  // #6001: one definition of "is this synthesis publishable", used BOTH as the
  // provider-acceptance gate and for the final result, so the chain can never
  // accept output the composer would later reject. Pure and cheap, so running
  // it once more below costs nothing and keeps failure classification exact.
  // Fault-tolerant on purpose: this runs once per provider AND once more for
  // the final result. An uncaught throw here escapes fetchInsights into
  // runSeed's withRetry, which would re-run the whole digest read and LLM
  // chain up to four times until the seed lock expires. Failing to null
  // classifies as GATE, keeps the LKG fail-safe, and stays visible in the log.
  const composeFromText = (text) => {
    // Reset per call. The chain may compose several times (once per provider
    // via callLLM's accept, then once more on the winning text), and the LAST
    // call is the one whose verdict the run acts on. Without the reset, a
    // composer that throws would leave an earlier provider's rule standing and
    // point the reader at a test that did not decide anything.
    synthesisRejectRule = null;
    try {
      return composeSynthesizedBrief(text, topStories, {
        validatorMode: BRIEF_VALIDATOR_MODE,
        sanitizeTitle,
        sourceFromStory: briefSourceFromStory,
        briefCluster,
        parsedSynthesis: parseBriefSynthesis(text, topStories.length),
        // Which rule rejected, not merely that one did. Every provider failing
        // the same gate is a gate that cannot be satisfied; different providers
        // failing different rules is the models behaving badly. The two need
        // opposite fixes and used to log the same sentence.
        onReject: (rule, detail) => {
          synthesisRejectRule = normalizeInsightsRejectRule(rule);
          const trimmed = typeof detail === 'string' && detail.length > 0
            ? ` — ${detail.slice(0, 500)}`
            : '';
          console.warn(`  [brief_synthesis] rule ${rule}${trimmed}`);
        },
      });
    } catch (err) {
      console.warn(`  [brief_synthesis] composer threw (${err.message}) — treating as rejected`);
      return null;
    }
  };

  // #6001: L1 may now walk the whole provider chain, and L2 below makes a
  // SECOND callLLM. Stamp the run's LLM start so L2 gets only the remainder —
  // otherwise two full call budgets could outlast the 120s seed lock.
  const llmRunStartedAtMs = Date.now();
  const synthesisResult = hasBriefCluster
    ? await callLLM(null, {
        systemPrompt: synthesisSystemPrompt(new Date().toISOString().split('T')[0]),
        userPrompt: synthesisUserPrompt(topStories),
        maxTokens: 900,
        // A model whose output trips the editorial gates must not strand the
        // run — keep the chain moving to one that passes.
        accept: composeFromText,
      })
    : null;
  const parsedSynthesis = synthesisResult
    ? parseBriefSynthesis(synthesisResult.text, topStories.length)
    : null;
  const composed = synthesisResult ? composeFromText(synthesisResult.text) : null;
  synthesisFailureCode = classifyInsightsSynthesisFailure({
    hasBriefCluster,
    synthesisResult,
    parsedSynthesis,
    composed,
  });

  if (composed) {
    worldBrief = composed.lead;
    briefStoryLines = composed.lines;
    worldBriefSources = composed.sources;
    briefProvider = synthesisResult.provider;
    briefModel = synthesisResult.model;
    if (composed.strippedCitations > 0) {
      console.warn(`  [brief_citation ENFORCE] stripped ${composed.strippedCitations} out-of-range citation(s)`);
    }
    if (composed.hallucinatedLines > 0) {
      console.warn(`  [brief_hallucination ${BRIEF_VALIDATOR_MODE.toUpperCase()}] ${composed.hallucinatedLines}/${topStories.length} synthesis lines flagged`);
    }
    console.log(`  Brief synthesized (top-${topStories.length}) via ${briefProvider} (${briefModel})`);
  } else {
    console.warn(
      `  [brief_synthesis] rejected (${synthesisFailureCode || INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER}) — `
      + 'falling back to single-headline brief',
    );
    const legacy = await generateLegacySingleHeadlineBrief(topStories, {
      callBudgetMs: Math.max(0, INSIGHTS_LLM_CALL_BUDGET_MS - (Date.now() - llmRunStartedAtMs)),
    });
    worldBrief = legacy.worldBrief;
    briefProvider = legacy.briefProvider;
    briefModel = legacy.briefModel;
    worldBriefSources = legacy.worldBriefSources;
    // A usable L2 headline must not clear an L1 synthesis failure. Keep this
    // run degraded so an existing LKG remains the freshness anchor and the
    // bounded failure metadata advances until L1 publishes successfully.
    status = resolveInsightsFallbackStatus({
      synthesisFailureCode,
      legacyStatus: legacy.status,
    });
  }

  const multiSourceCount = clusters.filter(c => (c.sources?.length ?? 0) >= 2 || c.entityCorroboration === true).length;
  const fastMovingCount = 0; // velocity not available in digest items

  const enrichedStories = topStories.map(story => {
    // Use digest threat when present and not keyword-sourced (keyword threat uses old taxonomy).
    // Fall back to categorizeStory() for legacy/incomplete payloads.
    const hasDigestThreat = story.threat?.level && story.threat?.source !== 'keyword';
    const { category, threatLevel } = hasDigestThreat
      ? { category: story.threat.category ?? 'general', threatLevel: story.threat.level }
      : categorizeStory(story.primaryTitle);
    const countryCode = extractCountryCode(story.primaryTitle) ?? null;
    return {
      primaryTitle: story.primaryTitle,
      primarySource: story.primarySource,
      primaryLink: story.primaryLink,
      pubDate: story.pubDate,
      sourceCount: story.sourceCount,
      uniqueSourceCount: Array.isArray(story.sources) ? story.sources.length : 0,
      sources: Array.isArray(story.sources) ? story.sources : [],
      lastUpdated: story.lastUpdated,
      memberTitles: Array.isArray(story.memberTitles) ? story.memberTitles : [story.primaryTitle],
      sourceTier: story.sourceTier,
      upstreamImportanceScore: story.upstreamImportanceScore,
      entityCorroboration: story.entityCorroboration === true,
      corroborationSourceCount: story.corroborationSourceCount ?? 0,
      importanceScore: story.importanceScore,
      effectiveImportanceScore: story.effectiveImportanceScore,
      velocity: { level: 'normal', sourcesPerHour: 0 },
      isAlert: story.isAlert,
      category,
      threatLevel,
      countryCode,
    };
  });

  // #4920: user-facing provenance — "compiled from N stories across M
  // sources" — plus the selection-gate drop counts. Read by
  // insights-loader/InsightsPanel; no proto involved (plain Redis JSON).
  const provenance = {
    storiesConsidered: normalizedItems.length,
    sourcesConsidered: new Set(normalizedItems.map(item => item.source).filter(Boolean)).size,
    selectionDrops: {
      admissibility: selectionStats.admissibilityDropped ?? 0,
      sourceCap: selectionStats.sourceCapDropped ?? 0,
      overflow: selectionStats.overflowDropped ?? 0,
    },
  };
  console.log(
    `  Provenance: ${provenance.storiesConsidered} stories / ${provenance.sourcesConsidered} sources; ` +
      `drops adm=${provenance.selectionDrops.admissibility} srcCap=${provenance.selectionDrops.sourceCap} overflow=${provenance.selectionDrops.overflow}`,
  );

  // #4921 staleness footer: the age window of the BRIEF'S OWN material —
  // the top stories the synthesis cites — not the whole digest pool
  // (#4928 external review: an unrelated fresh item made the footer claim
  // the brief's sources were fresher than they are).
  const pubTimes = topStories
    .map(story => new Date(story.pubDate).getTime())
    .filter(Number.isFinite);
  const sourceAgeRange = pubTimes.length > 0
    ? { newestMs: Math.max(...pubTimes), oldestMs: Math.min(...pubTimes) }
    : null;

  const payload = {
    worldBrief,
    briefStoryLines,
    sourceAgeRange,
    worldBriefSources,
    briefProvider,
    briefModel,
    status,
    topStories: enrichedStories,
    generatedAt: new Date().toISOString(),
    clusterCount: clusters.length,
    multiSourceCount,
    fastMovingCount,
    importanceSignals: observability,
    provenance,
    chinaNewsCoverage,
  };

  // LKG preservation: don't overwrite "ok" with "degraded"
  if (status === 'degraded') {
    const existing = await readExistingInsights();
    if (existing?.status === 'ok') {
      console.log('  LKG preservation: existing payload is "ok", skipping degraded overwrite');
      return decorateInsightsRun(
        preserveChinaNewsCoverageInLkg(existing, chinaNewsCoverage),
        {
          outcome: INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED,
          failureCode: synthesisFailureCode || INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER,
          rejectRule: synthesisRejectRule,
          briefEligibleClusters,
        },
      );
    }
  }

  return decorateInsightsRun(payload, {
    outcome: status === 'ok' ? INSIGHTS_RUN_OUTCOMES.PUBLISHED : INSIGHTS_RUN_OUTCOMES.DEGRADED,
    failureCode: synthesisFailureCode,
    rejectRule: synthesisRejectRule,
    briefEligibleClusters,
  });
}

export function declareRecords(data) {
  return Array.isArray(data?.topStories) ? data.topStories.length : 0;
}

async function writeInsightsChinaCoverage(data) {
  if (!data?.chinaNewsCoverage) {
    // LKG fallback predates the projection. Keep its timestamp honest: an
    // extended old projection will become CONTENT_STALE rather than green.
    await extendExistingTtl([CHINA_COVERAGE_KEY], CACHE_TTL);
    return;
  }
  await writeExtraKey(CHINA_COVERAGE_KEY, data.chinaNewsCoverage, CACHE_TTL);
}

/**
 * Project a decorated run's non-serialized metadata onto the freshness-patch
 * inputs. Exported so the run-meta -> seed-meta seam is unit-testable without
 * Redis I/O: a source-text guard over finalizeInsightsRun would still pass
 * with the wiring cut, so the mapping lives here as a pure function instead.
 */
export function insightsFreshnessPatchArgs(data, outcome, previousMeta, nowMs = Date.now()) {
  const runMeta = insightsRunMeta(data);
  return {
    previousMeta,
    outcome,
    failureCode: runMeta?.failureCode,
    rejectRule: runMeta?.rejectRule,
    nowMs,
    servedGeneratedAt: data?.generatedAt,
    briefEligibleClusters: runMeta?.briefEligibleClusters ?? null,
    providerOutcomes: insightsProviderOutcomesTrail(),
  };
}

async function finalizeInsightsRun(data, outcome, { previousMeta } = {}) {
  const [resolvedPreviousMeta] = await Promise.all([
    previousMeta === undefined
      ? readExistingSeedMeta('news', 'insights')
      : Promise.resolve(previousMeta),
    writeInsightsChinaCoverage(data),
  ]);
  return {
    freshnessMetaPatch: buildInsightsFreshnessMetaPatch(
      insightsFreshnessPatchArgs(data, outcome, resolvedPreviousMeta, Date.now()),
    ),
  };
}

export { callLLM, __setInsightsLlmTransportForTests };

if (_isDirectRun) {
  runSeed('news', 'insights', CANONICAL_KEY, fetchInsights, {
    lockTtlMs: INSIGHTS_LOCK_TTL_MS,
    validateFn: validateInsightsPayload,
    ttlSeconds: CACHE_TTL,
    sourceVersion: INSIGHTS_SOURCE_VERSION,

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 75,  // 2.5x the 30-minute cron; mirrors health.js seed-meta:news:insights
    // The source-status projection is not user-facing digest content. It is
    // retained separately so the China audit can distinguish an unavailable
    // source from a globally outranked one without changing the public payload.
    preserveKeys: [CHINA_COVERAGE_KEY],
    publishTransform: publishInsightsPayload,
    afterPublish: async (data) => {
      const runMeta = insightsRunMeta(data);
      return finalizeInsightsRun(
        data,
        runMeta?.outcome === INSIGHTS_RUN_OUTCOMES.PUBLISHED
          ? INSIGHTS_RUN_OUTCOMES.PUBLISHED
          : INSIGHTS_RUN_OUTCOMES.DEGRADED,
      );
    },
    afterValidationSkip: async (data, context) => {
      return finalizeInsightsRun(data, INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED, {
        previousMeta: context.existingSeedMeta,
      });
    },
  }).catch(async (err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    // Exit gracefully for cron — health endpoint flags stale data via
    // seed-meta. process.exit does not drain in-flight promises — flush
    // llm_call telemetry first (bounded by the 1.5s fetch timeout).
    await flushPendingLlmEvents();
    process.exit(0);
  });
}
