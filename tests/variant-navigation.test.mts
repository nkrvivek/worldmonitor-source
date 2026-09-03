import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { VARIANT_META } from '../src/config/variant-meta';

const panelLayout = readFileSync(new URL('../src/app/panel-layout.ts', import.meta.url), 'utf8');

describe('variant switcher navigation', () => {
  // Variants live on one host under their own path, so the switcher link for
  // each variant must be the same URL VARIANT_META canonicalizes it to.
  // Deriving the expectation here means a future host or path change moves
  // both sides at once instead of breaking this test.
  it('keeps every production variant link on that variant canonical route', () => {
    for (const [variant, meta] of Object.entries(VARIANT_META)) {
      const path = new URL(meta.url).pathname;
      assert.match(
        panelLayout,
        new RegExp(`vHref\\('${variant}', \`\\$\\{SITE_ORIGIN\\}${path}\`\\)`),
        `${variant} switcher link must target ${meta.url}`,
      );
    }
  });
});
