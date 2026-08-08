// The docs site. Builds to dist/, which the root build copies into
// public/docs/ so the Worker serves it from worldmonitor.sibt.ai/docs.
//
// This replaces the Mintlify deploy that vercel.json used to proxy /docs* to.
// Content is not authored here: scripts/prepare-content.mjs copies it out of
// ../docs on every build, so docs/ stays the one place a page is edited.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';

// Shared with the root build so every sitemap in this repo names one host.
import { SITE_ORIGIN } from '../scripts/_site.mjs';

import sidebar from './src/generated/sidebar.json' with { type: 'json' };
import specs from './src/generated/openapi.json' with { type: 'json' };

export default defineConfig({
  // The canonical host every other build in this repo emits. A docs sitemap
  // on a second host would not match robots.txt, which advertises this one.
  site: SITE_ORIGIN,
  // Must match BASE in scripts/prepare-content.mjs, which rebases every
  // in-page link by hand.
  base: '/docs',
  // The Worker sets html_handling: "none" and re-probes <path>/index.html
  // itself, so directory-style output is what it expects.
  build: { format: 'directory' },
  // Neither language has a page at its root — the nav opens on
  // `documentation`, which is where Mintlify sent /docs too. Astro writes these
  // as static redirect pages, so no server rule is needed.
  redirects: {
    '/': '/docs/documentation/',
    '/zh': '/docs/zh/documentation/',
  },
  integrations: [
    starlight({
      title: 'WorldMonitor Docs',
      // English is the root locale, so its URLs carry no language segment —
      // the same shape the pages had under Mintlify.
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        zh: { label: '中文', lang: 'zh-CN' },
      },
      // The API Reference pages are generated from the same 33 specs the
      // Mintlify nav pointed at; openAPISidebarGroups is what the plugin fills
      // in for them.
      plugins: [starlightOpenAPI(specs)],
      sidebar: [...sidebar, ...openAPISidebarGroups],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/koala73/worldmonitor',
        },
      ],
      pagefind: true,
    }),
  ],
  vite: {
    resolve: {
      alias: {
        '@mintlify': fileURLToPath(
          new URL('./src/components/mintlify', import.meta.url),
        ),
      },
    },
  },
});
