import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';

/**
 * Critical-path budget guard for the committed /pro build (#5396).
 *
 * public/pro is a committed build artifact: any PR that rebuilds the pro app
 * (a #5374-class change) can silently regress the page's critical path — grow
 * the modulepreloaded chunks, promote the auth SDK to eager, or add
 * render-blocking assets — and the only tripwire would be the weekly DebugBear
 * email, days later and averaged. These checks run at PR time against the
 * artifacts themselves, so the regression is named in CI, not in a report.
 *
 * The checks are pure functions over (html, sizeOf) so the same code that
 * guards the real artifacts is proven to have teeth against bad fixtures
 * below — a guard that cannot fail is not a guard.
 */

const PRO_DIR = new URL('../public/pro/', import.meta.url);

/** Render-blocking + pre-FCP fetch budget for /pro (entry, modulepreloads,
 *  stylesheets). Current path is ~628 KB (100 entry + 397 preload + 85 sentry
 *  + 46 css); 700 KB leaves growth headroom while catching a chunk-scale
 *  regression. Raising this number is a deliberate perf decision — cite the
 *  lab FCP/LCP impact in the PR that does it (#5396 baselines). */
const CRITICAL_PATH_BUDGET_BYTES = 700 * 1024;

/** Whole-assets cap: catches a second SDK-scale dependency landing in the
 *  bundle even off the critical path. Current total is ~2.6 MB. */
const TOTAL_ASSETS_BUDGET_BYTES = 6 * 1024 * 1024;

interface CriticalRefs {
  entry: string;
  refs: string[];
}

/** Pure: extract local pre-FCP asset refs (entry script, modulepreloads,
 *  preloads, stylesheets) from the page HTML. External hosts (analytics) and
 *  async/defer scripts are not part of the critical path. */
function parseCriticalRefs(html: string): CriticalRefs {
  const refs = new Set<string>();
  let entry = '';
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    const srcMatch = tag.match(/\b(?:src|href)="(\/pro\/assets\/[^"]+)"/);
    if (!srcMatch) continue;
    const path = srcMatch[1]!;
    if (/^<script/.test(tag)) {
      if (/\basync\b|\bdefer\b/.test(tag)) continue;
      if (!entry) entry = path;
      refs.add(path);
    } else if (/rel="(?:stylesheet|modulepreload)"/.test(tag)) {
      refs.add(path);
    } else if (/rel="preload"/.test(tag) && /as="(?:style|script|font)"/.test(tag)) {
      refs.add(path);
    }
  }
  return { entry, refs: [...refs] };
}

/** supabase-js ships GoTrueClient, and rollup names every pro chunk
 *  `index-<hash>.js` — so the auth SDK chunk is found by content, not by a
 *  filename the way the old Clerk chunk was. */
const AUTH_SDK_FINGERPRINT = /GoTrueClient/;

/** Pure: the asset refs whose source carries the auth SDK. */
function findAuthSdkChunks(sources: Map<string, string>): string[] {
  return [...sources]
    .filter(([, source]) => AUTH_SDK_FINGERPRINT.test(source))
    .map(([ref]) => ref);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pure: throws when an auth SDK chunk is referenced from the page HTML — it
 *  must never be script-src'd, preloaded, or modulepreloaded. */
function assertAuthSdkNotOnCriticalPath(refs: string[], authChunks: string[]): void {
  const eager = refs.find((r) => authChunks.includes(r));
  assert.equal(
    eager,
    undefined,
    `auth SDK chunk is on the /pro critical path (${eager}): it must stay a lazy dynamic import — `
      + 'eager-loading the auth SDK regressed the lab mobile score to 63 (#5396)',
  );
}

/** Pure: throws when the entry chunk stops importing the auth SDK dynamically —
 *  either the split was removed (inlined: parse cost on every load) or the
 *  import became static (eager fetch). */
function assertAuthSdkStaysLazy(entrySource: string, authChunk: string): void {
  const name = escapeForRegExp(authChunk.split('/').pop() ?? '');
  assert.doesNotMatch(
    entrySource,
    new RegExp(`(?:from\\s*"\\./${name}|import"\\./${name})`),
    'entry chunk imports the auth SDK statically — it must stay behind a dynamic import() (#5396)',
  );
  assert.match(
    entrySource,
    new RegExp(`import\\("\\./${name}"\\)`),
    'entry chunk no longer contains the dynamic auth SDK import — either the SDK was inlined into a bundled '
      + 'chunk (parsed on every load) or the auth loader moved; re-anchor this guard on the new load path (#5396)',
  );
}

/** Read every built JS chunk once, keyed by the ref shape the HTML uses. */
async function readChunkSources(): Promise<Map<string, string>> {
  const assetsDir = new URL('assets/', PRO_DIR);
  const sources = new Map<string, string>();
  for (const name of await readdir(assetsDir)) {
    if (!name.endsWith('.js')) continue;
    sources.set(`/pro/assets/${name}`, await readFile(new URL(name, assetsDir), 'utf8'));
  }
  return sources;
}

/** Pure: throws when the summed critical-path bytes exceed the budget. */
function assertCriticalPathBudget(refs: string[], sizeOf: (ref: string) => number): void {
  const total = refs.reduce((sum, r) => sum + sizeOf(r), 0);
  assert.ok(
    total <= CRITICAL_PATH_BUDGET_BYTES,
    `/pro critical path is ${Math.round(total / 1024)} KB (budget ${Math.round(CRITICAL_PATH_BUDGET_BYTES / 1024)} KB): `
      + `${refs.map((r) => `${r.split('/').pop()}=${Math.round(sizeOf(r) / 1024)}KB`).join(', ')} — `
      + 'raising the budget is a deliberate perf decision; cite lab FCP/LCP impact (#5396)',
  );
}

describe('pro critical path budget (#5396)', () => {
  it('keeps the real /pro page inside the critical-path budget', async () => {
    const html = await readFile(new URL('index.html', PRO_DIR), 'utf8');
    const { entry, refs } = parseCriticalRefs(html);
    assert.ok(entry, 'no entry <script> found in public/pro/index.html — parser or page structure changed');
    assert.ok(refs.length >= 2, `expected entry + preloads/styles on the critical path, found ${refs.length} refs`);

    const sizes = new Map<string, number>();
    for (const ref of refs) {
      const s = await stat(new URL(ref.replace('/pro/', './'), PRO_DIR));
      sizes.set(ref, s.size);
    }
    assertCriticalPathBudget(refs, (r) => sizes.get(r) ?? 0);
    assertAuthSdkNotOnCriticalPath(refs, findAuthSdkChunks(await readChunkSources()));
  });

  it('keeps the auth SDK a lazy dynamic import in the real entry chunk', async () => {
    const html = await readFile(new URL('index.html', PRO_DIR), 'utf8');
    const { entry } = parseCriticalRefs(html);
    const sources = await readChunkSources();
    const authChunks = findAuthSdkChunks(sources);
    assert.equal(
      authChunks.length,
      1,
      `expected exactly one auth SDK chunk in public/pro/assets, found ${authChunks.length} `
        + `(${authChunks.join(', ')}) — the SDK was duplicated across chunks or the fingerprint went stale (#5396)`,
    );
    assertAuthSdkStaysLazy(sources.get(entry) ?? '', authChunks[0]!);
  });

  it('keeps total /pro assets weight under the cap', async () => {
    const assetsDir = new URL('assets/', PRO_DIR);
    let total = 0;
    for (const name of await readdir(assetsDir)) {
      total += (await stat(new URL(name, assetsDir))).size;
    }
    assert.ok(
      total <= TOTAL_ASSETS_BUDGET_BYTES,
      `public/pro/assets is ${Math.round(total / 1024 / 1024 * 10) / 10} MB (cap ${TOTAL_ASSETS_BUDGET_BYTES / 1024 / 1024} MB) — `
        + 'a new heavyweight dependency landed in the pro bundle (#5396)',
    );
  });

  // Teeth: the same checkers must FAIL on the regressions they claim to catch.
  it('fails when the auth SDK is modulepreloaded (teeth)', () => {
    const html = '<script type="module" src="/pro/assets/index-abc.js"></script>'
      + '<link rel="modulepreload" href="/pro/assets/index-auth.js">';
    const { refs } = parseCriticalRefs(html);
    const authChunks = findAuthSdkChunks(new Map([
      ['/pro/assets/index-abc.js', 'const x = 1;'],
      ['/pro/assets/index-auth.js', 'class GoTrueClient {}'],
    ]));
    assert.deepEqual(authChunks, ['/pro/assets/index-auth.js']);
    assert.throws(() => assertAuthSdkNotOnCriticalPath(refs, authChunks), /critical path/);
  });

  it('fails when the entry imports the auth SDK statically or loses the split (teeth)', () => {
    const chunk = '/pro/assets/index-auth.js';
    assert.throws(
      () => assertAuthSdkStaysLazy('import{createClient}from"./index-auth.js";', chunk),
      /statically/,
    );
    assert.throws(
      () => assertAuthSdkStaysLazy('const x = 1; // no auth import anywhere', chunk),
      /no longer contains/,
    );
    assertAuthSdkStaysLazy('async function load(){const{createClient:n}=await import("./index-auth.js");}', chunk);
  });

  it('fails when the critical path exceeds the budget (teeth)', () => {
    const refs = ['/pro/assets/index-a.js', '/pro/assets/big-b.js'];
    assert.throws(
      () => assertCriticalPathBudget(refs, () => CRITICAL_PATH_BUDGET_BYTES),
      /budget/,
    );
  });
});
