import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));
const csp = vercelConfig.headers
  .find((entry) => entry.source === '/((?!docs|embed|embed\\.html).*)')
  ?.headers
  ?.find((header) => header.key === 'Content-Security-Policy')
  ?.value ?? '';
const variantBootstrapScript = indexHtml.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/)?.[1];

describe('variant inline bootstrap', () => {
  it('detects every public variant host before the app bundle loads', () => {
    for (const variant of ['happy', 'tech', 'finance', 'commodity', 'energy']) {
      assert.ok(
        indexHtml.includes(`h.startsWith('${variant}.'))v='${variant}'`),
        `index.html inline bootstrap must set data-variant for ${variant}.worldmonitor.app`,
      );
    }
  });

  // This fork serves the variants as paths on one host, so the pre-paint hint
  // has to read the path too. Without it /tech painted with no data-variant
  // and the bundle set it afterwards, which is the theme flash this script
  // exists to prevent.
  it('detects every variant path on this host before the app bundle loads', () => {
    for (const variant of ['happy', 'tech', 'finance', 'commodity', 'energy']) {
      assert.ok(
        variantBootstrapScript.includes(`p==='/${variant}'`),
        `index.html inline bootstrap must set data-variant for /${variant}`,
      );
    }
    assert.ok(
      variantBootstrapScript.includes("(location.pathname||'').toLowerCase().replace(/\\/+$/,'')"),
      'the path must be read case-insensitively and without a trailing slash, as src/config/variant.ts does',
    );
  });

  it('allows the inline variant bootstrap through the CSP', () => {
    assert.ok(variantBootstrapScript, 'index.html must include the inline variant bootstrap script');
    assert.ok(
      variantBootstrapScript.includes('worldmonitor-variant') && variantBootstrapScript.includes('document.documentElement.dataset.variant'),
      'the marked pre-paint script must retain variant bootstrapping',
    );

    const hash = createHash('sha256').update(variantBootstrapScript).digest('base64');
    assert.ok(
      csp.includes(`'sha256-${hash}'`),
      `Vercel Content-Security-Policy must include sha256-${hash} for the inline variant bootstrap script`,
    );
  });
});
