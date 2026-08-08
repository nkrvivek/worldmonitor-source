import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './story.js';

const CRAWLER = 'Twitterbot/1.0';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

async function fetchStory({ query = 'c=UA&t=ciianalysis', host = 'worldmonitor.app', ua = BROWSER } = {}) {
  const response = await handler(
    new Request(`https://${host}/api/story?${query}`, {
      headers: { host, 'user-agent': ua },
    }),
  );

  return {
    status: response.status,
    location: response.headers.get('location'),
    contentType: response.headers.get('content-type'),
    body: response.status === 302 ? '' : await response.text(),
  };
}

test('sends a reader to the SPA on the host they came from', async () => {
  const fork = await fetchStory({ host: 'worldmonitor.sibt.ai' });

  assert.equal(fork.status, 302);
  assert.equal(fork.location, 'https://worldmonitor.sibt.ai/?c=UA&t=ciianalysis');
});

test('leaves the redirect on upstream hosts pointing at upstream', async () => {
  const upstream = await fetchStory({ host: 'www.worldmonitor.app' });

  assert.equal(upstream.status, 302);
  assert.equal(upstream.location, 'https://worldmonitor.app/?c=UA&t=ciianalysis');
});

test('answers a crawler with meta tags rather than a redirect', async () => {
  const card = await fetchStory({ ua: CRAWLER });

  assert.equal(card.status, 200);
  assert.match(card.contentType, /text\/html/);
  assert.match(card.body, /<meta property="og:image"/);
  assert.match(card.body, /Ukraine Intelligence Brief/);
});

// Every link in the card used to name upstream, so a card shared from this
// fork advertised — and loaded its image from — a site we do not run.
test('points every link in the card at the host that served it', async () => {
  const card = await fetchStory({ host: 'worldmonitor.sibt.ai', ua: CRAWLER, query: 'c=UA&t=ciianalysis&s=71&l=high' });

  assert.match(card.body, /content="https:\/\/worldmonitor\.sibt\.ai\/api\/og-story\?c=UA&amp;t=ciianalysis&amp;s=71&amp;l=high"/);
  assert.match(card.body, /content="https:\/\/worldmonitor\.sibt\.ai\/api\/story\?c=UA&amp;t=ciianalysis"/);
  assert.equal(card.body.includes('worldmonitor.app'), false);
});

// Host is client-controlled. resolvePublicBaseUrl refuses one it does not
// know, and the card must not carry a spoofed origin into a reader's timeline.
test('ignores a spoofed host', async () => {
  const card = await fetchStory({ host: 'evil.example', ua: CRAWLER });

  assert.equal(card.body.includes('evil.example'), false);
  assert.match(card.body, /content="https:\/\/worldmonitor\.app\/api\/story\?/);
});
