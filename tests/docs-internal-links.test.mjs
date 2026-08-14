/**
 * Every internal link in a docs page must point at something the docs site
 * publishes — a page registered in docs/docs.json, or a file that ships under
 * docs/.
 *
 * docs-site/scripts/prepare-content.mjs rewrites links that match a published
 * page and LEAVES the rest alone, because app routes (/pro, /dashboard) must
 * keep pointing at the app. It counts what it left and prints the count, so a
 * mistyped prefix reads as an app route and the link 404s on the docs site
 * with nothing failing. That is how two pages came to write
 * `/docs/health-endpoints` while every other page wrote `/health-endpoints`.
 *
 * Links to the app itself are not written with a bare path here, so anything
 * unresolved is a typo. Add a page to docs.json, or add the asset, rather than
 * loosening this.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ROOT = new URL('../', import.meta.url).pathname;
const DOCS_DIR = join(ROOT, 'docs');

/** Every page path registered in docs.json navigation, in any language. */
function collectPages(node, pages = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectPages(item, pages);
    return pages;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'pages' && Array.isArray(value)) {
        for (const page of value) {
          if (typeof page === 'string') pages.add(page);
          else collectPages(page, pages);
        }
        continue;
      }
      if (value && typeof value === 'object') collectPages(value, pages);
    }
  }
  return pages;
}

function docsMdxFiles() {
  const out = execFileSync('git', ['ls-files', 'docs/*.mdx', 'docs/**/*.mdx'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

describe('docs internal links', () => {
  it('resolve to a published page or a file under docs/', () => {
    const pages = collectPages(JSON.parse(readFileSync(join(DOCS_DIR, 'docs.json'), 'utf8')));
    assert.ok(pages.size > 0, 'docs.json registered no pages — the walker is broken, not the docs');

    const unresolved = [];
    for (const file of docsMdxFiles()) {
      const body = readFileSync(join(ROOT, file), 'utf8');
      // Markdown links only. Bare paths in prose and code blocks are not links,
      // and an anchor or query on the end does not change the target.
      for (const match of body.matchAll(/\]\((\/[^)\s#?]*)/g)) {
        const target = match[1].replace(/^\//, '').replace(/\/$/, '');
        if (!target) continue;
        if (pages.has(target)) continue;
        if (existsSync(join(DOCS_DIR, target))) continue;
        unresolved.push(`${file}: ${match[1]}`);
      }
    }

    assert.deepEqual(
      unresolved,
      [],
      `link targets the docs site does not publish:\n  ${unresolved.join('\n  ')}`,
    );
  });
});
