import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { SITE_ORIGIN } from '../scripts/_site.mjs';

const SITE_HOST = new URL(SITE_ORIGIN).hostname;
const originalFetch = globalThis.fetch;
const importFetchCalls = [];
let indexNow;

before(async () => {
  globalThis.fetch = async (url, init) => {
    importFetchCalls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  };
  indexNow = await import(`../scripts/seo-indexnow-submit.mjs?test=${Date.now()}`);
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe('IndexNow submission', () => {
  it('submits one batch, for the host this fork serves', () => {
    assert.equal(importFetchCalls.length, 0, 'importing the module must not submit URLs');

    // Upstream ran seven hosts and needed a batch each. This fork serves
    // everything from one host, so a second batch would name a host we do not
    // answer — and every URL in an IndexNow request must share its host.
    assert.equal(indexNow.INDEXNOW_BATCHES.length, 1);
    const [batch] = indexNow.INDEXNOW_BATCHES;
    assert.equal(batch.host, SITE_HOST);
    assert.equal(batch.keyLocation, `${SITE_ORIGIN}/${batch.key}.txt`);
    assert.ok(
      batch.urls.every((url) => !url.includes('/blog/authors/')),
      'the blog has no author archives, so none may be submitted',
    );
    assert.equal(
      readFileSync(new URL(`../public/${batch.key}.txt`, import.meta.url), 'utf8').trim(),
      batch.key,
      'the deployed key file must match the configured key',
    );
  });

  it('keeps IndexNow coverage aligned with the committed root sitemap and blog corpus', () => {
    const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
    const sitemapUrls = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
      .map((match) => match[1].trim());
    const [batch] = indexNow.INDEXNOW_BATCHES;

    for (const url of sitemapUrls) assert.ok(batch.urls.includes(url), `${url} must be submitted`);
    for (const url of [
      `${SITE_ORIGIN}/blog/`,
      `${SITE_ORIGIN}/blog/glossary/`,
      `${SITE_ORIGIN}/blog/glossary/ais/`,
    ]) {
      assert.ok(batch.urls.includes(url), `${url} must be submitted`);
    }
    assert.equal(new Set(batch.urls).size, batch.urls.length, 'the batch must not contain duplicates');
  });

  it('keeps every submitted URL and key location on the declared host', () => {
    for (const batch of indexNow.INDEXNOW_BATCHES) {
      assert.equal(new URL(batch.keyLocation).hostname, batch.host);
      assert.match(batch.key, /^[a-f0-9]{32}$/);
      assert.equal(new URL(batch.keyLocation).pathname, `/${batch.key}.txt`);
      assert.equal(
        readFileSync(new URL(`../public/${batch.key}.txt`, import.meta.url), 'utf8').trim(),
        batch.key,
        `${batch.host}: public/${batch.key}.txt must be committed and match the configured key`,
      );
      assert.ok(batch.urls.length > 0, `${batch.host} must submit at least one URL`);
      for (const url of batch.urls) {
        assert.equal(new URL(url).hostname, batch.host, `${url} must match ${batch.host}`);
      }
    }
  });

  it('requires a direct key response with the exact key body', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, {
        status: 301,
        headers: { location: `${SITE_ORIGIN}/key.txt` },
      });
    };

    await assert.rejects(
      indexNow.verifyIndexNowKey(indexNow.INDEXNOW_BATCHES[0], { fetchImpl }),
      /direct 200/i,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.redirect, 'manual');
  });

  it('does not notify search engines when host ownership verification fails', async () => {
    const requests = [];
    const [batch] = indexNow.INDEXNOW_BATCHES;
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, {
        status: 301,
        headers: { location: `${SITE_ORIGIN}/key.txt` },
      });
    };

    await assert.rejects(
      indexNow.submitIndexNowBatch(batch, {
        endpoints: ['https://api.indexnow.org/IndexNow'],
        fetchImpl,
      }),
      /direct 200/i,
    );
    assert.deepEqual(requests.map(({ url }) => url), [batch.keyLocation]);
  });

  it('does not notify search engines when a direct key response has the wrong body', async () => {
    const requests = [];
    const [batch] = indexNow.INDEXNOW_BATCHES;
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response('wrong-indexnow-key', { status: 200 });
    };

    await assert.rejects(
      indexNow.submitIndexNowBatch(batch, {
        endpoints: ['https://api.indexnow.org/IndexNow'],
        fetchImpl,
      }),
      /key body does not match/i,
    );
    assert.deepEqual(requests.map(({ url }) => url), [batch.keyLocation]);
  });

  it('submits the key and the URL list after ownership verification', async () => {
    const requests = [];
    const [batch] = indexNow.INDEXNOW_BATCHES;
    const endpoint = 'https://www.bing.com/IndexNow';
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url) === batch.keyLocation) {
        return new Response(batch.key, { status: 200 });
      }
      return new Response(null, { status: 202 });
    };

    const results = await indexNow.submitIndexNowBatch(batch, {
      endpoints: [endpoint],
      fetchImpl,
    });

    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[0].value.status, 202);
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      host: batch.host,
      key: batch.key,
      keyLocation: batch.keyLocation,
      urlList: batch.urls,
    });
  });

  it('runs only when an operator asks, because nothing here reports a deploy', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/indexnow-submit.yml', import.meta.url),
      'utf8',
    );

    // Upstream triggered on Vercel's deployment_status event. This fork deploys
    // to Cloudflare by hand, so that event never arrives and the workflow would
    // sit silent while looking wired.
    assert.match(workflow, /^ {2}workflow_dispatch:$/m);
    assert.doesNotMatch(workflow, /^ {2}deployment_status:$/m);
    assert.doesNotMatch(workflow, /vercel\[bot\]/);
    assert.match(workflow, /INDEXNOW_BATCHES\[0\]/);
    assert.match(workflow, /test -f "public\/\$\{KEY_PATH\}"/);
    assert.match(workflow, /node scripts\/seo-indexnow-submit\.mjs$/m);
  });
});
