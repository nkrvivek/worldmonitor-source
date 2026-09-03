import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { SITE_ORIGIN } from '../scripts/_site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The site-wide corpus files an agent reads before it fetches anything else.
// Each one may link a docs page as markdown; every such link has to answer.
const CORPUS = [
  'public/llms.txt',
  'public/llms-full.txt',
  'public/agents.md',
  'public/agent.txt',
  'public/pricing.md',
  'public/support.md',
  'public/mcp-server.md',
];

/** Every page path under a docs.json nav node. */
function collectPages(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectPages(child, out);
  } else if (node && typeof node === 'object') {
    if (node.pages) collectPages(node.pages, out);
    if (node.groups) collectPages(node.groups, out);
    if (node.tabs) collectPages(node.tabs, out);
  } else if (typeof node === 'string') {
    out.push(node);
  }
  return out;
}

function publishedPages() {
  const config = JSON.parse(readFileSync(join(ROOT, 'docs/docs.json'), 'utf8'));
  return new Set(collectPages(config.navigation.languages));
}

function advertisedSlugs() {
  const pattern = new RegExp(`${SITE_ORIGIN}/docs/([a-zA-Z0-9/_-]+)\\.md`, 'g');
  const found = new Map();
  for (const file of CORPUS) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const match of readFileSync(path, 'utf8').matchAll(pattern)) {
      if (!found.has(match[1])) found.set(match[1], file);
    }
  }
  return found;
}

describe('docs markdown companions', () => {
  it('only advertises docs markdown for pages the docs build publishes', () => {
    // docs-site/scripts/prepare-content.mjs writes one .md companion per page
    // in docs.json. A corpus link to a page that is not in the nav gets no
    // companion, so it 404s — which is how /docs/accounts.md and
    // /docs/usage-rate-limits.md sat dead while the corpus advertised them.
    const published = publishedPages();
    const advertised = advertisedSlugs();
    assert.ok(advertised.size > 0, 'no docs markdown links found — check CORPUS paths');

    for (const [slug, file] of advertised) {
      assert.ok(
        published.has(slug),
        `${file} links ${SITE_ORIGIN}/docs/${slug}.md, but ${slug} is not published in docs/docs.json`,
      );
    }
  });

  it('has a built companion for every advertised page, once the docs are built', (t) => {
    // public/docs/ is build output and git-ignored, so this only runs after a
    // docs build. Skipping is stated, not silent.
    if (!existsSync(join(ROOT, 'public/docs'))) {
      t.skip('public/docs is not built in this checkout');
      return;
    }
    for (const [slug, file] of advertisedSlugs()) {
      assert.ok(
        existsSync(join(ROOT, 'public/docs', `${slug}.md`)),
        `${file} links /docs/${slug}.md but public/docs/${slug}.md was not built`,
      );
    }
  });
});
