#!/usr/bin/env node
/**
 * #4920 (c): external recall benchmark.
 *
 * Daily job (runs in the feed-validation GitHub Actions workflow, after
 * validation — no Railway slot): reads the current article index produced
 * from GDELT's mirrored bulk GKG files, checks whether each appears anywhere
 * in the digest we actually ingested
 * (news:digest:v1:full:en), and publishes the recall percentage + the
 * missed headlines to news:recall-benchmark:v1.
 *
 * This is the pipeline's first ground-truth completeness number: "of the
 * stories a neutral external index considers top news today, what
 * fraction does WorldMonitor carry?" Misses are listed by lowest
 * similarity so coverage holes are actionable (add a feed / fix a
 * wrapper), not just a percentage.
 *
 * Exit policy: analysis job — any upstream failure logs and exits 0
 * (the workflow must not redden on GDELT jitter). Missing Redis creds
 * skip silently (local runs).
 */

import { computeRecall } from './_recall-benchmark-core.mjs';
import { pathToFileURL } from 'node:url';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { CHROME_UA } from './_seed-utils.mjs';
import { GDELT_BULK_ARTICLES_KEY } from './_gdelt-bulk-contract.mjs';

const RECALL_KEY = 'news:recall-benchmark:v1';
const META_KEY = 'seed-meta:news:recall-benchmark';
const DIGEST_KEY = 'news:digest:v1:full:en';
const DIGEST_WARM_PATH = '/api/news/v1/list-feed-digest?variant=full&lang=en';
// Our own host. This used to name api.worldmonitor.app, which is upstream's,
// exactly the trap scripts/check-seed-freshness.mjs already documents. Our
// relay key is not in that deployment's WORLDMONITOR_VALID_KEYS, so the warm
// below answered 401 {"error":"Invalid API key"} and this job published
// nothing on four consecutive green runs. Measured 2026-08-25, same key and
// same second: worldmonitor.sibt.ai 200 with a 228KB digest, the other 401.
// API_BASE_URL still overrides.
const DEFAULT_API_BASE = 'https://worldmonitor.sibt.ai';
// The digest is an on-demand cache, not a seed. cachedFetchJson writes it with
// a 900s TTL and returns early on a hit WITHOUT refreshing that TTL, while the
// primary warm rail runs on `*/15` — the same 900 seconds. So the key is absent
// for stretches of up to a quarter hour, and this job reads it once a day at a
// moment nobody chose. Four consecutive runs lost that race, logged a skip and
// exited 0, and the freshness monitor reported newsRecallBenchmark EMPTY while
// every workflow run stayed green. scripts/seed-insights.mjs has solved this
// since it was written; the benchmark never got the same treatment.
const DIGEST_WARM_ATTEMPTS = 10;
const DIGEST_WARM_POLL_MS = 3_000;
// The reference index is a 15-minute bulk product. A 3h budget tolerates
// routine missed materializer cycles without letting a preserved snapshot be
// laundered into a newly checked recall publication.
export const GDELT_BULK_REFERENCE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
export const GDELT_BULK_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function unwrapEnvelope(parsed) {
  // Canonical keys may be stored as { data, fetchedAt, ... } envelopes or
  // bare payloads — same tolerance as scripts/seed-insights.mjs.
  if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
    return parsed.data;
  }
  return parsed;
}

export function materializedReferenceItems(payload) {
  const seenUrls = new Set();
  return (Array.isArray(payload?.articles) ? payload.articles : []).flatMap((article) => {
    const title = typeof article?.title === 'string' ? article.title.trim() : '';
    const url = typeof article?.url === 'string' && /^https?:\/\//.test(article.url)
      ? article.url
      : undefined;
    if (title.length < 10 || (url && seenUrls.has(url))) return [];
    if (url) seenUrls.add(url);
    return [{ title, url, vertical: 'gdelt-bulk' }];
  });
}

export function requireFreshMaterializedReference(reference, nowMs = Date.now()) {
  const fetchedAtMs = typeof reference?.fetchedAt === 'number'
    ? reference.fetchedAt
    : Date.parse(reference?.fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    throw new Error(`${GDELT_BULK_ARTICLES_KEY} fetchedAt is unparseable: ${reference?.fetchedAt}`);
  }
  const ageMs = nowMs - fetchedAtMs;
  if (ageMs > GDELT_BULK_REFERENCE_MAX_AGE_MS) {
    throw new Error(
      `${GDELT_BULK_ARTICLES_KEY} stale reference`
      + ` (${Math.round(ageMs / 60000)}min old; max ${GDELT_BULK_REFERENCE_MAX_AGE_MS / 60000}min)`,
    );
  }
  if (ageMs < -GDELT_BULK_MAX_FUTURE_SKEW_MS) {
    throw new Error(
      `${GDELT_BULK_ARTICLES_KEY} future reference`
      + ` (${Math.round(-ageMs / 60000)}min ahead; max ${GDELT_BULK_MAX_FUTURE_SKEW_MS / 60000}min)`,
    );
  }
  return reference;
}

async function readDigestRaw(creds, _redisCommand) {
  const response = await _redisCommand(creds, ['GET', DIGEST_KEY]);
  return typeof response?.result === 'string' && response.result.length > 0
    ? response.result
    : null;
}

export async function warmAndReadDigest({
  creds,
  _redisCommand = upstashCommand,
  _fetch = (...args) => fetch(...args),
  _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  _logger = console,
} = {}) {
  const apiBase = process.env.API_BASE_URL || DEFAULT_API_BASE;
  const relayKey = process.env.WORLDMONITOR_RELAY_KEY || '';
  const headers = { 'User-Agent': CHROME_UA, Origin: 'https://worldmonitor.app' };
  if (relayKey) headers['X-WorldMonitor-Key'] = relayKey;
  const keyNote = relayKey ? '' : ' (no WORLDMONITOR_RELAY_KEY — Origin-only auth)';
  _logger.log(`${DIGEST_KEY} absent — warming the cache via RPC${keyNote}`);
  try {
    const resp = await _fetch(`${apiBase}${DIGEST_WARM_PATH}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) _logger.warn(`  digest warm returned HTTP ${resp.status}`);
  } catch (err) {
    _logger.warn(`  digest warm failed: ${err.message}`);
  }
  // The gateway awaits its Redis write before responding, so one readback after
  // a 200 should hit. The poll covers the other outcomes — a degraded build, a
  // concurrent warm-ping landing late — where the single fixed sleep this was
  // ported from read back nothing and sent the run down its fallback path.
  for (let attempt = 0; attempt < DIGEST_WARM_ATTEMPTS; attempt += 1) {
    await _sleep(DIGEST_WARM_POLL_MS);
    const raw = await readDigestRaw(creds, _redisCommand);
    if (raw) return raw;
  }
  return null;
}

export async function runRecallBenchmark({
  _getCreds = getOptionalUpstashCreds,
  _redisCommand = upstashCommand,
  _now = Date.now,
  _fetch = (...args) => fetch(...args),
  _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  _logger = console,
} = {}) {
  const creds = _getCreds();
  if (!creds) {
    _logger.log('recall-benchmark skipped (no UPSTASH_REDIS_REST_URL/TOKEN in env)');
    return;
  }
  const nowMs = _now();

  // 1. Digest titles — what we actually ingested.
  const [digestResponse, referenceResponse] = await Promise.all([
    _redisCommand(creds, ['GET', DIGEST_KEY]),
    _redisCommand(creds, ['GET', GDELT_BULK_ARTICLES_KEY]),
  ]);
  let digestRaw = typeof digestResponse?.result === 'string' && digestResponse.result.length > 0
    ? digestResponse.result
    : null;
  if (!digestRaw) {
    digestRaw = await warmAndReadDigest({ creds, _redisCommand, _fetch, _sleep, _logger });
  }
  if (!digestRaw) {
    // Loud, not silent. `WARN … skipping` plus exit 0 is exactly what let four
    // green runs publish nothing while the freshness monitor emailed EMPTY
    // every three hours. The annotation surfaces on the workflow summary.
    _logger.warn(
      `::warning title=recall-benchmark skipped::${DIGEST_KEY} was absent and did not appear`
      + ` within ${(DIGEST_WARM_ATTEMPTS * DIGEST_WARM_POLL_MS) / 1000}s of a warm —`
      + ` ${RECALL_KEY} was not published this run.`,
    );
    return;
  }
  const digest = unwrapEnvelope(JSON.parse(digestRaw));
  const digestTitles = Object.values(digest?.categories ?? {})
    .flatMap((bucket) => (Array.isArray(bucket?.items) ? bucket.items : []))
    .map((item) => item?.title)
    .filter((title) => typeof title === 'string' && title.length > 0);
  if (digestTitles.length === 0) {
    _logger.warn('WARN: digest carried zero titles — skipping');
    return;
  }

  // 2. External reference set from the bulk materializer. The daily workflow
  // does no GDELT network I/O; it consumes the same bounded 24h article index
  // the 15-minute Railway materializer already produced.
  if (typeof referenceResponse?.result !== 'string' || referenceResponse.result.length === 0) {
    _logger.warn(`WARN: ${GDELT_BULK_ARTICLES_KEY} missing/empty — cannot benchmark, skipping`);
    return;
  }
  const reference = requireFreshMaterializedReference(
    unwrapEnvelope(JSON.parse(referenceResponse.result)),
    nowMs,
  );
  const externalItems = materializedReferenceItems(reference);
  if (externalItems.length < 20) {
    _logger.warn(`WARN: only ${externalItems.length} external articles — too thin to publish, skipping`);
    return;
  }

  // 3. Recall.
  const result = computeRecall(externalItems, digestTitles);
  _logger.log(
    `recall: ${result.recallPct}% (${result.matched}/${result.total} external stories present; ` +
      `${digestTitles.length} digest titles; ${result.unvectorizable} unvectorizable)`,
  );
  for (const miss of result.missed) {
    _logger.log(`  MISSED (best ${miss.bestScore}): ${miss.title}`);
  }

  // 4. Publish.
  const payload = {
    v: 1,
    checkedAt: nowMs,
    referenceFetchedAt: reference.fetchedAt,
    recallPct: result.recallPct,
    matched: result.matched,
    total: result.total,
    digestTitleCount: digestTitles.length,
    threshold: result.threshold,
    // Untrusted external titles: clamp length so a hostile/broken GDELT
    // response cannot balloon the published payload.
    missed: result.missed.map((m) => ({
      ...m,
      title: String(m.title).slice(0, 200),
      // Only http(s) URLs, clamped — GDELT fields are untrusted input.
      url: typeof m.url === 'string' && /^https?:\/\//.test(m.url) ? m.url.slice(0, 300) : undefined,
    })),
  };
  await _redisCommand(creds, ['SET', RECALL_KEY, JSON.stringify(payload), 'EX', String(3 * 86400)]);
  await _redisCommand(creds, ['SET', META_KEY, JSON.stringify({
    fetchedAt: payload.checkedAt,
    recordCount: result.total,
    sourceVersion: 'recall-benchmark-v1',
  }), 'EX', String(7 * 86400)]);
  // Durable activation marker — NO TTL by design (#4927 re-review P1); see
  // validate-rss-feeds.mjs for the rationale.
  await _redisCommand(creds, ['SET', 'seed-activated:news:recall-benchmark', '1']);
  _logger.log(`published ${RECALL_KEY}`);
}

// Importable for tests; only run when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRecallBenchmark().catch((err) => {
    // Analysis job: never redden the workflow on upstream jitter.
    console.warn(`recall-benchmark failed (non-fatal): ${err.message}`);
  });
}
