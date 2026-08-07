import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './og-story.js';

async function renderOgStory(query = '', host = 'worldmonitor.app') {
  const response = await handler(
    new Request(`https://${host}/api/og-story${query ? `?${query}` : ''}`, {
      headers: { host },
    }),
  );

  return { status: response.status, body: await response.text(), response };
}

test('normalizes unsupported level values to prevent SVG script injection', async () => {
  const injectedLevel = encodeURIComponent('</text><script>alert(1)</script><text>');
  const response = await renderOgStory(`c=US&s=50&l=${injectedLevel}`);

  assert.equal(response.status, 200);
  assert.equal(/<script/i.test(response.body), false);
  assert.match(response.body, />NORMAL<\/text>/);
});

test('uses a known level when it is allowlisted', async () => {
  const response = await renderOgStory('c=US&s=88&l=critical');

  assert.equal(response.status, 200);
  assert.match(response.body, />CRITICAL<\/text>/);
  assert.match(response.body, /#ef4444/);
});

test('serves SVG with the caching headers a crawler expects', async () => {
  const { response } = await renderOgStory('c=US');

  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.match(response.headers.get('cache-control'), /max-age=3600/);
});

// The footer signs the card. Rendered on this fork it used to read
// worldmonitor.app, crediting a site the sharer is not on.
test('signs the card with the host that rendered it', async () => {
  const fork = await renderOgStory('c=US', 'worldmonitor.sibt.ai');
  assert.match(fork.body, />worldmonitor\.sibt\.ai · /);

  const upstream = await renderOgStory('c=US', 'www.worldmonitor.app');
  assert.match(upstream.body, />worldmonitor\.app · /);
});
