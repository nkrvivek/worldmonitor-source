import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchUsniPosts } from '../scripts/seed-usni-fleet.mjs';

const POSTS = [{ id: 1, link: 'https://news.usni.org/x', date: '2026-08-18T00:00:00', title: { rendered: 'Fleet Tracker' }, content: { rendered: '<p>x</p>' } }];

const forbidden = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve(null) });
const served = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(POSTS) });

test('direct is used when it works, and the proxy is never called', async () => {
  let proxyCalls = 0;
  const posts = await fetchUsniPosts({
    directFetch: served,
    proxyFetchJson: () => { proxyCalls++; return Promise.resolve(POSTS); },
    proxyAuth: 'user:pass@host:1',
  });
  assert.deepEqual(posts, POSTS);
  assert.equal(proxyCalls, 0);
});

test('a 403 on direct falls back to the proxy', async () => {
  const posts = await fetchUsniPosts({
    directFetch: forbidden,
    proxyFetchJson: () => Promise.resolve(POSTS),
    proxyAuth: 'user:pass@host:1',
  });
  assert.deepEqual(posts, POSTS);
});

test('a thrown direct error falls back to the proxy', async () => {
  const posts = await fetchUsniPosts({
    directFetch: () => Promise.reject(new Error('ETIMEDOUT')),
    proxyFetchJson: () => Promise.resolve(POSTS),
    proxyAuth: 'user:pass@host:1',
  });
  assert.deepEqual(posts, POSTS);
});

test('with no proxy configured the direct failure is what surfaces', async () => {
  // Not the proxy's error, and not a generic one. An operator reading the log
  // has to see the status the source actually returned.
  await assert.rejects(
    () => fetchUsniPosts({ directFetch: forbidden, proxyFetchJson: () => Promise.resolve(POSTS), proxyAuth: '' }),
    /USNI wp-json: HTTP 403/,
  );
});

test('a proxy failure reports both legs, not just the second', async () => {
  await assert.rejects(
    () => fetchUsniPosts({
      directFetch: forbidden,
      proxyFetchJson: () => Promise.reject(new Error('HTTP 502')),
      proxyAuth: 'user:pass@host:1',
    }),
    (err) => {
      assert.match(err.message, /HTTP 403/);
      assert.match(err.message, /HTTP 502/);
      return true;
    },
  );
});

test('an empty article list is a failure, not an empty fleet', async () => {
  await assert.rejects(
    () => fetchUsniPosts({
      directFetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) }),
      proxyFetchJson: () => Promise.resolve(POSTS),
      proxyAuth: 'user:pass@host:1',
    }),
    /No fleet tracker articles/,
  );
});
