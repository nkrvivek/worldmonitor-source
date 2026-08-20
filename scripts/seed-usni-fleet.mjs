#!/usr/bin/env node

// USNI Fleet Tracker — weekly carrier/ARG disposition report.
//
// Ported 2026-08-09 from seedUsniFleet in scripts/ais-relay.cjs (:5594-5677).
// The parser was already its own module (scripts/lib/usni-fleet-parser.cjs)
// and is reused verbatim; only the fetch-and-write shell moves to the
// container rail. get-usni-fleet-report.ts reads the live key and falls back
// to the 7-day stale mirror, which is why afterPublish writes both.
//
// Source: USNI News WordPress JSON API, no key. The relay carried a Froxy
// fixed-IP proxy fallback for when WordPress/Cloudflare blocked its egress;
// the container started direct-only, on the rule that the proxy leg gets
// added only once a block is measured. It was measured on 2026-08-19: the
// container logged `USNI wp-json: HTTP 403` while the same URL answered 200
// from a residential IP, so the block is on the egress address and not on
// the URL. The proxy leg below is that fallback, direct-first.

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed, atomicPublish, httpsProxyFetchRaw, resolveProxy } from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
const { usniStripHtml, usniParseArticle } = require('./lib/usni-fleet-parser.cjs');

loadEnvFile(import.meta.url);

const USNI_URL = 'https://news.usni.org/wp-json/wp/v2/posts?categories=4137&per_page=1';
const CANONICAL_KEY = 'usni-fleet:sebuf:v1';
const STALE_KEY = 'usni-fleet:sebuf:stale:v1';
// 24h against a 6h cron and a 720-min health gate. The relay ran 12h (2x the
// cron), but 12h equals the gate exactly, so a merely-late run would expire the
// key and report EMPTY (crit) instead of STALE_SEED (warn) — the fleet-guard
// invariant is ttlSeconds > maxStaleMin * 60. USNI posts weekly; a day-old
// fleet tracker served under a warn is the right degradation.
const CACHE_TTL = 86_400;
const STALE_TTL = 604_800;

// A 200 carrying no articles is the source answering, not a blocked fetch.
function requireArticles(wpData) {
  if (!Array.isArray(wpData) || !wpData.length) throw new Error('No fleet tracker articles');
  return wpData;
}

/**
 * Read the fleet-tracker posts, direct first and through the proxy only when
 * direct cannot answer. Both legs are injected so the fallback is testable
 * without a network.
 *
 * A direct 200 is final, including a 200 that carries no articles: that is
 * the source saying it has nothing, and retrying it through a different exit
 * IP would ask the same question twice. Only a failure to be answered at all
 * reaches the proxy.
 */
export async function fetchUsniPosts({
  directFetch = fetch,
  proxyFetchJson = async (url, auth) => JSON.parse(
    (await httpsProxyFetchRaw(url, auth, { accept: 'application/json' })).buffer.toString('utf8'),
  ),
  proxyAuth = resolveProxy(),
  url = USNI_URL,
} = {}) {
  let answered = false;
  let posts;
  let directError;
  try {
    const resp = await directFetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`USNI wp-json: HTTP ${resp.status}`);
    posts = await resp.json();
    answered = true;
  } catch (err) {
    directError = err;
  }
  if (answered) return requireArticles(posts);

  // Say what the source did, not just that the last attempt failed. Without
  // the direct status in the message, a blocked egress and a broken proxy
  // read identically in the seed log.
  if (!proxyAuth) throw directError;
  console.warn(`  [USNI] Direct fetch failed (${directError.message}); retrying via proxy`);
  try {
    return requireArticles(await proxyFetchJson(url, proxyAuth));
  } catch (proxyError) {
    throw new Error(`USNI direct: ${directError.message}; via proxy: ${proxyError.message}`);
  }
}

async function fetchUsniFleet() {
  const wpData = await fetchUsniPosts();

  const post = wpData[0];
  const articleUrl = post.link || `https://news.usni.org/?p=${post.id}`;
  const articleDate = post.date || new Date().toISOString();
  const articleTitle = usniStripHtml(post.title?.rendered || 'USNI Fleet Tracker');
  const htmlContent = post.content?.rendered || '';
  if (!htmlContent) throw new Error('Empty article content');

  const report = usniParseArticle(htmlContent, articleUrl, articleDate, articleTitle);
  if (report.parsingWarnings.length > 0) {
    console.warn('  parser warnings:', report.parsingWarnings.join('; '));
  }
  return report;
}

// A report with zero vessels is a parse failure, not a fleet in port —
// keep last-good instead of blanking the panel.
function validate(report) {
  return Array.isArray(report?.vessels) && report.vessels.length > 0;
}

export function declareRecords(report) {
  return Array.isArray(report?.vessels) ? report.vessels.length : 0;
}

if (process.argv[1]?.endsWith('seed-usni-fleet.mjs')) {
  runSeed('military', 'usni-fleet', CANONICAL_KEY, fetchUsniFleet, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'usni-fleet',
    recordCount: (report) => report.vessels.length,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 720,
    // The stale mirror outlives a missed cycle by design; it only ever holds
    // a payload the validator accepted.
    afterPublish: async (report) => {
      await atomicPublish(STALE_KEY, report, validate, STALE_TTL, {
        sourceVersion: 'usni-fleet',
        schemaVersion: 1,
        recordCount: report.vessels.length,
      });
    },
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
