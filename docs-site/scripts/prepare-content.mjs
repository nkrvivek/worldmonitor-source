// Copies the published docs into this Astro project and rewrites what Mintlify
// used to handle for us.
//
// `docs/` stays the single source of truth. Nothing here edits it: every page
// is read, transformed in memory, and written under src/content/docs/. Which
// pages count as published comes from docs/docs.json — the same nav Mintlify
// read — so a page that is on disk but not in the nav stays unpublished, and a
// page in the nav with no file fails the run instead of vanishing quietly.
//
// Three transforms:
//   1. Root-relative links get the /docs base, but only when they name a real
//      page. A link to /pro or /dashboard points at the app, not at us.
//   2. Mintlify's six components get an import line, so MDX can resolve them.
//   3. Nothing else. Frontmatter is already title + description on all 241
//      pages, which is what Starlight reads.
//
// It also writes public/llms.txt. Mintlify generated that file for us; the site
// -wide public/llms.txt and the agent-mode view both link to /docs/llms.txt, so
// the docs build has to produce one or those links go dead.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared with the root build so every absolute URL this repo emits names one
// host.
import { SITE_ORIGIN } from '../../scripts/_site.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const REPO = join(SITE, '..');
const DOCS = join(REPO, 'docs');
const CONTENT = join(SITE, 'src', 'content', 'docs');
const GENERATED = join(SITE, 'src', 'generated');
const PUBLIC = join(SITE, 'public');

// Directories of OpenAPI specs that pages link to directly. They ship as static
// files so a reader can download the spec, and so those links keep working.
const SPEC_DIRS = ['api', 'openapi'];

// The URL prefix the Worker serves the docs from. Must match `base` in
// astro.config.mjs — the two are read by different code and drift silently.
const BASE = '/docs';

// Absolute links in llms.txt: an agent reads that file out of context, so a
// root-relative path is no use to it. Must match `site` in astro.config.mjs.
const ORIGIN = SITE_ORIGIN;

// Every Mintlify component the corpus actually uses, measured across all 242
// files. Adding one here is not enough: it needs a shim in
// src/components/mintlify/ or the build fails on an unresolved import.
const COMPONENTS = ['CodeGroup', 'Update', 'Info', 'Warning', 'Tip', 'Note'];

/** Every page path under a docs.json nav node, in nav order. */
function collectPages(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectPages(child, out);
  } else if (node && typeof node === 'object') {
    if (node.pages) collectPages(node.pages, out);
  } else if (typeof node === 'string') {
    out.push(node);
  }
  return out;
}

function tabNodes(tab) {
  return tab.groups ?? tab.pages ?? [];
}

/**
 * The sidebar, built from the English nav and labelled in both languages.
 *
 * Mintlify split the nav into three tabs; Starlight has one sidebar, so the
 * tabs become top-level groups. Chinese labels come from the same position in
 * the zh-Hans nav — the two navs are maintained in parallel, so position is the
 * only join key docs.json offers.
 */
function buildSidebar(enLang, zhLang) {
  const sidebar = [];
  enLang.tabs.forEach((tab, tabIndex) => {
    const zhTab = zhLang.tabs[tabIndex];
    const groups = tabNodes(tab).filter((node) => node.group);
    const zhGroups = zhTab ? tabNodes(zhTab).filter((node) => node.group) : [];

    groups.forEach((group, groupIndex) => {
      const pages = collectPages(group.pages ?? []);
      if (pages.length === 0) return; // OpenAPI-only group; starlight-openapi owns those.
      const zhGroup = zhGroups[groupIndex];
      sidebar.push({
        label: `${tab.tab} — ${group.group}`,
        ...(zhTab && zhGroup
          ? { translations: { zh: `${zhTab.tab} — ${zhGroup.group}` } }
          : {}),
        items: pages.map((page) => ({ slug: page })),
      });
    });
  });
  return sidebar;
}

/**
 * The OpenAPI specs the API Reference tab is built from, one entry per spec.
 *
 * Mintlify generated those pages from `openapi:` refs in the nav; starlight-
 * openapi does the same job and needs the same list, so it is read from the
 * same place rather than hand-kept. English only — the plugin renders one set
 * of endpoint pages, and the specs themselves are in English.
 */
function collectSpecs(enLang) {
  const specs = [];
  const seen = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.openapi) {
      const base = `api/${node.group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      if (!seen.has(base)) {
        seen.add(base);
        specs.push({ base, label: node.group, schema: `./public/${node.openapi}` });
      }
    }
    if (node.pages) walk(node.pages);
  };
  for (const tab of enLang.tabs) walk(tabNodes(tab));
  return specs;
}

/**
 * Rewrite root-relative links that name a published page.
 *
 * Code fences are left alone — a shell example writing to /etc is not a link.
 * A link that matches no page is left alone too, and counted, because those are
 * app routes (/pro, /dashboard) that must keep pointing at the app.
 */
function rewriteLinks(source, linkable, stats) {
  const segments = source.split(/(^```[\s\S]*?^```)/gm);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) return segment; // the fence itself
      return segment.replace(
        /(\]\(|href=")(\/[^)"\s#]*)/g,
        (whole, opener, path) => {
          const slug = path.replace(/^\//, '').replace(/\/$/, '');
          if (!linkable.has(slug)) {
            stats.leftAlone.add(path);
            return whole;
          }
          stats.rewritten += 1;
          return `${opener}${BASE}/${slug}`;
        },
      );
    })
    .join('');
}

/**
 * Every markdown companion this script wrote on an earlier run.
 *
 * Astro copies public/ to the site root, so a companion written here is served
 * at /docs/<page>.md — the shape Mintlify used to serve, and the shape the
 * site-wide corpus links to. Stale files have to go first, or a page renamed in
 * docs.json keeps answering under its old slug forever.
 */
async function clearMarkdownCompanions(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SPEC_DIRS.includes(entry.name)) continue; // rebuilt wholesale above
      await clearMarkdownCompanions(path);
    } else if (entry.name.endsWith('.md')) {
      await rm(path);
    }
  }
}

/** Add an import line for each Mintlify component the page uses. */
function injectImports(source) {
  const used = COMPONENTS.filter((name) =>
    new RegExp(`<${name}[\\s/>]`).test(source),
  );
  if (used.length === 0) return source;

  const imports = used
    .map((name) => `import ${name} from '@mintlify/${name}.astro';`)
    .join('\n');

  // Frontmatter always comes first on these pages; the import block goes
  // straight after it so MDX sees it before any usage.
  const end = source.indexOf('\n---', 3);
  if (!source.startsWith('---') || end === -1) {
    throw new Error('page has no frontmatter block');
  }
  const head = source.slice(0, end + 4);
  const body = source.slice(end + 4);
  return `${head}\n${imports}\n${body}`;
}

/** title and description from a page's frontmatter, both required. */
function frontmatter(source, page) {
  const end = source.indexOf('\n---', 3);
  if (!source.startsWith('---') || end === -1) {
    throw new Error(`${page}: no frontmatter block`);
  }
  const head = source.slice(3, end);
  const read = (key) => {
    const match = head.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const title = read('title');
  if (!title) throw new Error(`${page}: frontmatter has no title`);
  return { title, description: read('description') };
}

/**
 * llms.txt — one link per published page, grouped the way the sidebar is.
 *
 * Written from the same nav and the same frontmatter the pages carry, so a page
 * added to docs.json appears here without anyone remembering to add it.
 */
function buildLlmsTxt(sidebar, fronts) {
  const lines = [
    '# World Monitor Documentation',
    '',
    '> Every published World Monitor documentation page, grouped as the docs ' +
      'navigation groups them. Product guides, API reference, MCP and agent ' +
      'integration, and the Chinese translations.',
    '',
    'Generated by docs-site/scripts/prepare-content.mjs from docs/docs.json. ' +
      'Do not edit by hand.',
    '',
    `The OpenAPI reference is rendered from the specs at ${ORIGIN}/docs/openapi/ ` +
      `and ${ORIGIN}/docs/api/. The site-wide briefing is at ${ORIGIN}/llms.txt.`,
  ];

  for (const group of sidebar) {
    lines.push('', `## ${group.label}`, '');
    for (const item of group.items) {
      const front = fronts.get(item.slug);
      if (!front) continue;
      const suffix = front.description ? `: ${front.description}` : '';
      lines.push(`- [${front.title}](${ORIGIN}${BASE}/${item.slug}/)${suffix}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const config = JSON.parse(await readFile(join(DOCS, 'docs.json'), 'utf8'));
  const languages = config.navigation.languages;
  const enLang = languages.find((lang) => lang.language === 'en');
  const zhLang = languages.find((lang) => lang.language === 'zh-Hans');
  if (!enLang || !zhLang) throw new Error('docs.json lost a language');

  const pages = [];
  for (const lang of [enLang, zhLang]) {
    for (const tab of lang.tabs) pages.push(...collectPages(tabNodes(tab)));
  }
  // Pages and spec files share one set: a link is rebased when it names
  // something this site serves, and left alone otherwise.
  const linkable = new Set(pages);
  for (const dir of SPEC_DIRS) {
    const target = join(PUBLIC, dir);
    await rm(target, { recursive: true, force: true });
    await cp(join(DOCS, dir), target, { recursive: true });
    for (const file of await readdir(join(DOCS, dir))) {
      linkable.add(`${dir}/${file}`);
    }
  }

  await rm(CONTENT, { recursive: true, force: true });
  await mkdir(CONTENT, { recursive: true });
  await clearMarkdownCompanions(PUBLIC);

  const stats = { rewritten: 0, leftAlone: new Set(), components: 0 };

  const fronts = new Map();
  for (const page of pages) {
    const source = await readFile(join(DOCS, `${page}.mdx`), 'utf8');
    fronts.set(page, frontmatter(source, page));
    const rewritten = rewriteLinks(source, linkable, stats);
    let out = injectImports(rewritten);
    if (out !== rewritten) stats.components += 1;

    const target = join(CONTENT, `${page}.mdx`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, out, 'utf8');

    // The markdown companion an agent fetches instead of the HTML page. It is
    // the page source with the same links rebased, minus the component import
    // block — that block only exists so MDX can resolve <Info> and friends, and
    // it reads as noise to anything consuming the markdown.
    const companion = join(PUBLIC, `${page}.md`);
    await mkdir(dirname(companion), { recursive: true });
    await writeFile(companion, rewritten, 'utf8');
  }

  await mkdir(GENERATED, { recursive: true });
  const sidebar = buildSidebar(enLang, zhLang);
  await writeFile(
    join(GENERATED, 'sidebar.json'),
    `${JSON.stringify(sidebar, null, 2)}\n`,
    'utf8',
  );

  await writeFile(join(PUBLIC, 'llms.txt'), buildLlmsTxt(sidebar, fronts), 'utf8');

  const specs = collectSpecs(enLang);
  await writeFile(
    join(GENERATED, 'openapi.json'),
    `${JSON.stringify(specs, null, 2)}\n`,
    'utf8',
  );

  const appLinks = [...stats.leftAlone].sort();
  console.log(
    `docs: ${pages.length} pages, ${stats.rewritten} links rebased to ${BASE}, ` +
      `${stats.components} pages importing components`,
  );
  console.log(
    `docs: ${appLinks.length} link targets left pointing at the app: ${appLinks.join(', ')}`,
  );
  console.log(`docs: ${specs.length} OpenAPI specs wired into the API reference`);
  console.log(`docs: llms.txt lists ${fronts.size} pages`);
  console.log(`docs: ${pages.length} markdown companions written to ${BASE}/<page>.md`);
}

await main();
