#!/usr/bin/env node
/**
 * Tell search engines which of our URLs changed, after a deploy.
 *
 *   node scripts/seo-indexnow-submit.mjs
 *
 * The script verifies that our ownership key is served from our own host
 * before it notifies anyone. IndexNow requires every URL in one request to
 * share a host; upstream ran seven hosts and needed a batch each, this fork
 * serves everything from one, so there is one batch.
 *
 * The committed root sitemap and the blog source corpus are the submission
 * inventory, so adding a canonical page does not require a second URL list.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SITE_ORIGIN } from './_site.mjs';

const SITE_HOST = new URL(SITE_ORIGIN).hostname;

// Keys must be genuinely random (`openssl rand -hex 16`). The previous value
// (a7f3e9d1b2c44e8f9a0b1c2d3e4f5a6b) is permanently rejected by Bing with
// 403 UserForbiddedToAccessSite even though the key file served fine — never
// reuse it (#6055).
export const INDEXNOW_KEY = 'f25eec9ff48713a38c0a66a7f0628d46';
const BLOG_DIR = new URL('../blog-site/src/content/blog/', import.meta.url);
const GLOSSARY_SOURCE = new URL('../blog-site/src/data/glossary.ts', import.meta.url);
const ROOT_SITEMAP = new URL('../public/sitemap.xml', import.meta.url);
const USER_AGENT = `WorldMonitor-IndexNow/1.0 (+${SITE_ORIGIN})`;

function decodeXml(value) {
  return String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function uniqueSorted(urls) {
  return [...new Set(urls)].sort();
}

function getRootSitemapUrls() {
  const source = readFileSync(ROOT_SITEMAP, 'utf8');
  const urls = [...source.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
    .map((match) => decodeXml(match[1].trim()));
  if (urls.length === 0) throw new Error(`${ROOT_SITEMAP.pathname} contains no canonical URLs`);
  return urls;
}

const ROOT_SITEMAP_URLS = getRootSitemapUrls();

function getSitemapUrlsForHost(host) {
  const urls = ROOT_SITEMAP_URLS.filter((value) => new URL(value).hostname === host);
  if (urls.length === 0) throw new Error(`${ROOT_SITEMAP.pathname} contains no URLs for ${host}`);
  return urls;
}

function getBlogPostUrls() {
  return readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => `${SITE_ORIGIN}/blog/posts/${basename(file, '.md')}/`)
    .sort();
}

function getBlogGlossaryUrls() {
  const source = readFileSync(GLOSSARY_SOURCE, 'utf8');
  const slugs = [...source.matchAll(/^\s*slug:\s*'([^']+)'/gm)].map((match) => match[1]);
  if (slugs.length === 0) throw new Error(`${GLOSSARY_SOURCE.pathname} contains no glossary slugs`);
  return slugs.map((slug) => `${SITE_ORIGIN}/blog/glossary/${slug}/`).sort();
}

function getBlogUrls() {
  return [
    `${SITE_ORIGIN}/blog/`,
    `${SITE_ORIGIN}/blog/glossary/`,
    ...getBlogGlossaryUrls(),
    ...getBlogPostUrls(),
  ];
}

const SITE_URLS = uniqueSorted([
  ...getSitemapUrlsForHost(SITE_HOST),
  ...getBlogUrls(),
]);

function batch(host, urls, key = INDEXNOW_KEY) {
  return {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urls,
  };
}

export const INDEXNOW_BATCHES = Object.freeze([batch(SITE_HOST, SITE_URLS)]);

export const INDEXNOW_ENDPOINTS = Object.freeze([
  'https://api.indexnow.org/IndexNow',
  'https://www.bing.com/IndexNow',
  'https://searchadvisor.naver.com/indexnow',
  'https://search.seznam.cz/indexnow',
  'https://yandex.com/indexnow',
]);

/**
 * Confirm that a batch's ownership key is served directly from its declared host.
 */
export async function verifyIndexNowKey(batchConfig, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(batchConfig.keyLocation, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'text/plain',
      'User-Agent': USER_AGENT,
    },
  });
  if (response.status !== 200) {
    throw new Error(
      `${batchConfig.host} IndexNow key must return a direct 200 from ${batchConfig.keyLocation}; got ${response.status}`,
    );
  }
  const body = (await response.text()).trim();
  if (body !== batchConfig.key) {
    throw new Error(`${batchConfig.host} IndexNow key body does not match ${batchConfig.key}`);
  }
}

async function submit(endpoint, batchConfig, fetchImpl) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      host: batchConfig.host,
      key: batchConfig.key,
      keyLocation: batchConfig.keyLocation,
      urlList: batchConfig.urls,
    }),
  });
  return {
    endpoint,
    host: batchConfig.host,
    status: response.status,
    ok: response.ok,
  };
}

/**
 * Verify one host and notify each configured IndexNow endpoint about its URLs.
 */
export async function submitIndexNowBatch(
  batchConfig,
  {
    endpoints = INDEXNOW_ENDPOINTS,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  await verifyIndexNowKey(batchConfig, { fetchImpl });
  return Promise.allSettled(endpoints.map((endpoint) => submit(endpoint, batchConfig, fetchImpl)));
}

/**
 * Submit all requested host batches and fail after reporting every endpoint result.
 */
export async function runIndexNowSubmission({
  batches = INDEXNOW_BATCHES,
  endpoints = INDEXNOW_ENDPOINTS,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  let failed = false;
  for (const batchConfig of batches) {
    logger.log(`\n[${batchConfig.host}] (${batchConfig.urls.length} URLs)`);
    try {
      const results = await submitIndexNowBatch(batchConfig, { endpoints, fetchImpl });
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { endpoint, ok, status } = result.value;
          failed ||= !ok;
          logger.log(`  ${ok ? '✓' : '✗'} ${endpoint.replace('https://', '')} → ${status}`);
        } else {
          failed = true;
          logger.log(`  ✗ error: ${result.reason}`);
        }
      }
    } catch (error) {
      failed = true;
      logger.error(`  ✗ ${error?.message ?? error}`);
    }
  }
  if (failed) throw new Error('one or more IndexNow submissions failed');
}

async function main() {
  await runIndexNowSubmission();
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`[indexnow] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
