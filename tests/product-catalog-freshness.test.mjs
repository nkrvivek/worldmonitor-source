/**
 * Product catalog freshness tests.
 *
 * Verifies that generated files (products.generated.ts, product-ids.generated.ts, tiers.json)
 * match the canonical catalog in convex/config/productCatalog.ts.
 * Bidirectional: checks generated→catalog AND catalog→generated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PRODUCT_ID_ALLOWED_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];

// Catalog ids are Stripe price lookup keys now, not Dodo `pdt_` ids. A bare
// `wm_` prefix cannot be the guard — user API keys and checkout metadata keys
// carry it too — so the guard matches the exact lookup keys the catalog
// declares. That is stronger than a prefix: a key renamed in the catalog
// changes what this scans for in the same commit.
const CATALOG_LOOKUP_KEY_PATTERN = /providerPriceId:\s*["']([^"']+)["']/g;
const PRODUCT_ID_EXCLUDE_PATTERNS = [
  'node_modules',
  'dist/',
  '.git',
  '.claude/worktrees/',
  'convex/_generated/',
  'convex/config/productCatalog',
  'api/product-catalog',
  'api/_product-catalog.generated',
  'api/_product-fallback-prices',
  'src/config/products.generated',
  'src/config/product-ids.generated',
  'pro-test/src/generated/',
  'public/pro/',
  'tests/',
  'convex/__tests__/',
  'e2e/',
  // Zero-import leaf: statically imported by the eager dashboard code, so it
  // cannot import the catalog without breaking the eager-chunk budget. It
  // mirrors the Pro-family ids as literals; its drift-guard test asserts them
  // against the generated catalog, giving the same catalog-sync this guard wants.
  'src/services/pro-activation-state',
  'scripts/generate-product-config',
  'scripts/generate-public-product-facts',
];

function isMissingPathError(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

function collectRawProductIds(root, filesystem = {}, lookupKeys = ['pdt_']) {
  const {
    readdir = readdirSync,
    stat = statSync,
    readFile = readFileSync,
  } = filesystem;
  const results = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = readdir(currentDir);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const relPath = relative(root, fullPath).replace(/\\/g, '/');
      let fileStat;
      try {
        fileStat = stat(fullPath);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      const checkPath = fileStat.isDirectory() ? `${relPath}/` : relPath;

      if (PRODUCT_ID_EXCLUDE_PATTERNS.some((pattern) => checkPath.includes(pattern))) {
        continue;
      }

      if (fileStat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const extIdx = entry.lastIndexOf('.');
      const ext = extIdx !== -1 ? entry.substring(extIdx) : '';
      if (!PRODUCT_ID_ALLOWED_EXTENSIONS.includes(ext) || entry.includes('.test.')) continue;

      let content;
      try {
        content = readFile(fullPath, 'utf8');
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      if (!lookupKeys.some((key) => content.includes(key))) continue;

      content.split(/\r?\n/).forEach((line, index) => {
        if (lookupKeys.some((key) => line.includes(key))) {
          results.push(`${relPath}:${index + 1}:${line}`);
        }
      });
    }
  }

  walk(root);
  return results;
}

describe('Product catalog freshness', () => {
  // Read generated files
  const generatedProductsSrc = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
  const tiersJson = JSON.parse(readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8'));
  const proLocalesDir = join(ROOT, 'pro-test/src/locales');
  const readProLocaleFiles = () => Object.fromEntries(
    readdirSync(proLocalesDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => [file, readFileSync(join(proLocalesDir, file), 'utf8')]),
  );

  // Extract product IDs from generated TS (regex since we can't import TS in node:test)
  const generatedProductIds = [...generatedProductsSrc.matchAll(/'(wm_[^']+)'/g)].map(m => m[1]);

  it('generated products.ts contains valid price lookup keys', () => {
    assert.ok(generatedProductIds.length >= 4, `Expected at least 4 lookup keys, got ${generatedProductIds.length}`);
    for (const id of generatedProductIds) {
      assert.match(id, /^wm_[a-z0-9_]+$/, `Lookup key should be a wm_ slug: ${id}`);
    }
  });

  it('generated tiers.json has expected tier structure', () => {
    assert.ok(Array.isArray(tiersJson), 'tiers.json should be an array');
    assert.ok(tiersJson.length >= 3, `Expected at least 3 tiers, got ${tiersJson.length}`);

    const names = tiersJson.map(t => t.name);
    assert.ok(names.includes('Free'), 'Missing Free tier');
    assert.ok(names.includes('Pro'), 'Missing Pro tier');
    assert.ok(names.includes('API'), 'Missing API tier');
    assert.ok(
      !names.includes('Pro Business'),
      'Pro Business merged into Pro on 2026-08-05 and must not come back as its own tier',
    );
  });

  it('Pro tier has monthly and annual prices', () => {
    const pro = tiersJson.find(t => t.name === 'Pro');
    assert.ok(pro, 'Pro tier not found');
    assert.ok(typeof pro.monthlyPrice === 'number', 'Pro should have monthlyPrice');
    assert.ok(typeof pro.annualPrice === 'number', 'Pro should have annualPrice');
    assert.ok(pro.monthlyProductId, 'Pro should have monthlyProductId');
    assert.ok(pro.annualProductId, 'Pro should have annualProductId');
  });

  it('API tier has monthly and annual prices', () => {
    const api = tiersJson.find(t => t.name === 'API');
    assert.ok(api, 'API tier not found');
    assert.ok(typeof api.monthlyPrice === 'number', 'API should have monthlyPrice');
    assert.ok(typeof api.annualPrice === 'number', 'API should have annualPrice');
  });

  it('generated products.ts includes typed plan limits', () => {
    assert.match(generatedProductsSrc, /export const PLAN_LIMITS = \{/, 'Missing PLAN_LIMITS export');
    assert.match(generatedProductsSrc, /"api_starter": \{"apiRequestsPerDay":1000,/, 'API Starter daily limit missing');
    assert.match(generatedProductsSrc, /"api_business": \{"apiRequestsPerDay":10000,/, 'API Business daily limit missing');
    assert.match(generatedProductsSrc, /"enterprise": \{"apiRequestsPerDay":null,/, 'Enterprise unlimited daily limit missing');
  });

  it('generated tiers expose plan limits for public plans', () => {
    const pro = tiersJson.find(t => t.name === 'Pro');
    const api = tiersJson.find(t => t.name === 'API');
    const ent = tiersJson.find(t => t.name === 'Enterprise');

    // Pro carries the allowances Pro Business used to carry (merged 2026-08-05).
    assert.equal(pro?.planLimits?.mcpCallsPerDay, 250, 'Pro MCP daily limit should be visible');
    assert.equal(pro?.planLimits?.dashboardAiCallsPerDay, 2500, 'Pro dashboard-AI daily limit should be visible');
    assert.equal(api?.planLimits?.apiRequestsPerDay, 1000, 'API daily limit should be visible');
    assert.equal(api?.planLimits?.dashboardAiCallsPerDay, 1000, 'API dashboard-AI daily limit should be visible');
    assert.equal(ent?.planLimits?.apiRequestsPerDay, null, 'Enterprise daily limit should be unlimited');
    assert.equal(ent?.planLimits?.dashboardAiCallsPerDay, null, 'Enterprise dashboard-AI limit should be unlimited');
  });

  it('Enterprise tier is custom with contact CTA', () => {
    const ent = tiersJson.find(t => t.name === 'Enterprise');
    assert.ok(ent, 'Enterprise tier not found');
    assert.equal(ent.price, null, 'Enterprise price should be null');
    assert.equal(ent.cta, 'Contact Sales');
  });

  it('English pro locale pricing feature placeholders cover every publicVisible tier group', () => {
    const enLocale = JSON.parse(readFileSync(join(proLocalesDir, 'en.json'), 'utf8'));
    const pricingTiers = enLocale?.pricing?.tiers;
    assert.ok(
      pricingTiers && typeof pricingTiers === 'object' && !Array.isArray(pricingTiers),
      'en.json missing pricing.tiers',
    );

    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const blocks = catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1);
    const visibleGroups = new Set();
    for (const block of blocks) {
      if (block.includes('publicVisible: true')) {
        const groupMatch = block.match(/tierGroup:\s*['"]([^'"]+)['"]/);
        if (groupMatch) visibleGroups.add(groupMatch[1]);
      }
    }

    const groupToName = { free: 'Free', pro: 'Pro', api_starter: 'API', api_business: 'API Business', enterprise: 'Enterprise' };
    const groupToLocaleKey = { free: 'free', pro: 'pro', api_starter: 'api', api_business: 'apiBusiness', enterprise: 'enterprise' };
    const tiersByLocaleKey = new Map(tiersJson.map((tier) => [tier.localeKey, tier]));

    for (const group of visibleGroups) {
      const expectedName = groupToName[group];
      assert.ok(
        expectedName,
        'Catalog tier group ' + group + ' is publicVisible but has no expected generated tier name mapping in this test',
      );

      const localeKey = groupToLocaleKey[group];
      assert.ok(
        localeKey,
        'Catalog tier group ' + group + ' is publicVisible but has no expected pro locale key mapping in this test',
      );

      const generatedTier = tiersByLocaleKey.get(localeKey);
      assert.ok(
        generatedTier,
        'Missing generated tier for publicVisible catalog group ' + group + ' (expected localeKey ' + localeKey + ')',
      );
      assert.equal(
        generatedTier.name,
        expectedName,
        'Generated tier name mismatch for publicVisible catalog group ' + group,
      );

      const localeTier = pricingTiers[localeKey];
      assert.ok(
        localeTier && typeof localeTier === 'object' && !Array.isArray(localeTier),
        'en.json missing pricing.tiers.' + localeKey + ' for publicVisible catalog group ' + group,
      );
      assert.ok(
        Array.isArray(localeTier.features),
        'en.json pricing.tiers.' + localeKey + '.features must be an array',
      );
      assert.deepEqual(
        localeTier.features,
        generatedTier.features,
        'en.json pricing.tiers.' + localeKey + '.features is not synced to generated tier features for ' + group,
      );
    }
  });

  it('Pro locale MCP pricing feature mentions Claude Desktop and the call allowance', () => {
    // A locale may write the allowance in its own numeral system — fa uses
    // Persian-Indic digits, as it already did for the API request limits before
    // it was translated. Fold those to ASCII so the assertion reads the NUMBER
    // rather than the glyphs. The guard is unchanged in strength: if the
    // allowance moved again and a locale still said the old number, this would
    // still fail.
    //
    // Covers Devanagari (hi), Bengali and Thai (th) as well, not just the two
    // ranges fa needs: those locales currently write ASCII, but fa is exactly
    // what happens on the pass that changes that, and a false CI failure on an
    // unrelated PR is the predictable cost of enumerating only what is needed
    // today. A digit from an unlisted script passes through unchanged, so the
    // assertion fails loudly rather than matching something wrong.
    // (Number('۵') is NaN — JS parses ASCII digits only — so this has to be
    // codepoint arithmetic against each block's zero.)
    const DIGIT_ZEROS = [0x0030, 0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50];
    const toAsciiDigits = (value) =>
      value.replace(/\p{Nd}/gu, (digit) => {
        const cp = digit.codePointAt(0);
        const zero = DIGIT_ZEROS.find((z) => cp >= z && cp < z + 10);
        return zero === undefined ? digit : String(cp - zero);
      });

    for (const [file, src] of Object.entries(readProLocaleFiles())) {
      const locale = JSON.parse(src);
      const features = locale?.pricing?.tiers?.pro?.features;
      assert.ok(Array.isArray(features), `${file} missing pricing.tiers.pro.features`);
      const feature = features.find((value) => /\bMCP\b/.test(value));
      assert.equal(typeof feature, 'string', `${file} missing a Pro pricing feature mentioning MCP`);
      assert.match(feature, /\bMCP\b/, `${file} Pro MCP feature should mention MCP`);
      assert.match(feature, /Claude Desktop/, `${file} Pro MCP feature should mention Claude Desktop`);
      assert.match(
        toAsciiDigits(feature),
        /\b250\b/,
        `${file} Pro MCP feature should mention the 250 calls/day allowance`,
      );
    }
  });

  it('Edge and Railway catalogs consume the generated canonical tier config', () => {
    const expectedFeature = tiersJson.find((tier) => tier.localeKey === 'pro')?.features?.find((f) => /\bMCP\b/.test(f));
    assert.equal(
      expectedFeature,
      'MCP + SDK access for Claude Desktop & other AI clients (250 calls/day)',
      'generated Pro MCP feature changed unexpectedly',
    );

    const generatedCatalog = JSON.parse(
      readFileSync(join(ROOT, 'shared/product-catalog.generated.json'), 'utf8'),
    );
    assert.ok(generatedCatalog.tierConfig.pro.features.includes(expectedFeature));
    assert.deepEqual(
      generatedCatalog.publicTierGroups,
      ['free', 'pro', 'api_starter', 'api_business', 'enterprise'],
    );

    const edgeSrc = readFileSync(join(ROOT, 'api/product-catalog.js'), 'utf8');
    const relaySrc = readFileSync(join(ROOT, 'scripts/ais-relay.cjs'), 'utf8');
    assert.match(edgeSrc, /from '\.\/_product-catalog\.generated\.js'/);
    assert.match(relaySrc, /requireShared\('product-catalog\.generated\.json'\)/);
    assert.doesNotMatch(edgeSrc, /MANUAL MIRROR/);
    assert.doesNotMatch(relaySrc, /MANUAL MIRROR/);
  });

  // The license chips say who may use the product for work, and they travel in
  // `highlightFeatures` — a field the generator does NOT sync into the locales.
  // So a chip could say "Personal license" on the live /pro page while the
  // catalog sells a commercial license, with every other gate green. That is
  // exactly what the Pro/Pro Business merge did to 26 locale files.
  it('license chips (highlightFeatures) match across the generated bundle, edge module, tiers.json, and en.json', () => {
    // The generated JSON bundle is what BOTH consumers (Railway seeder via
    // requireShared, edge endpoint via _product-catalog.generated.js) serve
    // from, so it is the single mirror to check. en.json stays hand-edited —
    // the generator does not sync highlightFeatures into the locales, which
    // is exactly the drift this test exists to catch.
    const bundle = JSON.parse(
      readFileSync(join(ROOT, 'shared/product-catalog.generated.json'), 'utf8'),
    );
    const bundleHighlights = {};
    for (const [group, config] of Object.entries(bundle.tierConfig)) {
      if (Array.isArray(config.highlightFeatures)) bundleHighlights[group] = config.highlightFeatures;
    }
    // Three groups carry chips: pro, api_starter, api_business. Free and
    // enterprise carry none. It was four until Pro Business merged into Pro.
    assert.ok(Object.keys(bundleHighlights).length >= 3,
      'generated bundle: expected >=3 tier highlightFeature lists');

    // The edge module is a second emitted artifact of the same generator run;
    // a partial regen could leave it stale, so pin each chip string into it.
    const edgeGenerated = readFileSync(join(ROOT, 'api/_product-catalog.generated.js'), 'utf8');

    const groupToLocaleKey = { free: 'free', pro: 'pro', api_starter: 'api', api_business: 'apiBusiness', enterprise: 'enterprise' };
    const tiersByLocaleKey = new Map(tiersJson.map((tier) => [tier.localeKey, tier]));
    const enLocale = JSON.parse(readFileSync(join(proLocalesDir, 'en.json'), 'utf8'));

    for (const [group, highlights] of Object.entries(bundleHighlights)) {
      const localeKey = groupToLocaleKey[group];
      assert.ok(localeKey, 'bundle tier group ' + group + ' has no localeKey mapping in this test');
      assert.deepEqual(highlights, tiersByLocaleKey.get(localeKey)?.highlightFeatures,
        'license chips for ' + group + ' drifted between the generated bundle and tiers.json (catalog highlightFeatures)');
      assert.deepEqual(enLocale.pricing.tiers[localeKey]?.highlightFeatures, highlights,
        'en.json pricing.tiers.' + localeKey + '.highlightFeatures is stale — the generator does not sync this field, edit it by hand');
      for (const chip of highlights) {
        assert.ok(edgeGenerated.includes(JSON.stringify(chip).slice(1, -1)),
          'api/_product-catalog.generated.js is missing chip "' + chip + '" for ' + group + ' — partial regen?');
      }
    }
  });

  // A tier is only sellable if the generated row carries BOTH price lookup
  // keys: pro-test/src/services/checkout.ts derives its checkout ids from
  // these rows, and a missing key silently drops one billing period from the
  // pricing page.
  it('every purchasable generated tier carries both checkout price keys', () => {
    for (const tier of tiersJson) {
      if (tier.price === null || tier.cta === 'Contact Sales') continue;
      if (!tier.monthlyPrice && !tier.annualPrice) continue; // Free
      assert.ok(tier.monthlyProductId, `${tier.name} should have monthlyProductId`);
      assert.ok(tier.annualProductId, `${tier.name} should have annualProductId`);
      assert.equal(typeof tier.monthlyPrice, 'number', `${tier.name} should have monthlyPrice`);
      assert.equal(typeof tier.annualPrice, 'number', `${tier.name} should have annualPrice`);
    }
  });

  it('the pro locale placeholders no longer carry a Pro Business block', () => {
    // Dead locale keys are invisible: nothing renders them, so nothing fails
    // when they drift. They were removed with the tier on 2026-08-05.
    for (const [file, src] of Object.entries(readProLocaleFiles())) {
      const tiers = JSON.parse(src)?.pricing?.tiers ?? {};
      assert.ok(!('proBusiness' in tiers), `${file} still carries pricing.tiers.proBusiness`);
    }
  });

  it('generated files and pro locale placeholders are fresh (re-running generator produces same output)', () => {
    // Capture current generated content
    const currentProducts = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
    const currentProductIds = readFileSync(join(ROOT, 'src/config/product-ids.generated.ts'), 'utf8');
    const currentTiers = readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8');
    const currentEdgeCatalog = readFileSync(join(ROOT, 'api/_product-catalog.generated.js'), 'utf8');
    const currentSharedCatalog = readFileSync(join(ROOT, 'shared/product-catalog.generated.json'), 'utf8');
    const currentRelayCatalog = readFileSync(join(ROOT, 'scripts/shared/product-catalog.generated.json'), 'utf8');
    const currentPublicFacts = readFileSync(join(ROOT, 'public/product-facts.json'), 'utf8');
    const currentRelayFacts = readFileSync(join(ROOT, 'scripts/shared/product-facts.generated.json'), 'utf8');
    const currentLocales = readProLocaleFiles();

    // Re-run generator
    execSync('npm run product:facts', { cwd: ROOT, stdio: 'pipe' });

    // Compare
    const freshProducts = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
    const freshProductIds = readFileSync(join(ROOT, 'src/config/product-ids.generated.ts'), 'utf8');
    const freshTiers = readFileSync(join(ROOT, 'pro-test/src/generated/tiers.json'), 'utf8');
    const freshEdgeCatalog = readFileSync(join(ROOT, 'api/_product-catalog.generated.js'), 'utf8');
    const freshSharedCatalog = readFileSync(join(ROOT, 'shared/product-catalog.generated.json'), 'utf8');
    const freshRelayCatalog = readFileSync(join(ROOT, 'scripts/shared/product-catalog.generated.json'), 'utf8');
    const freshPublicFacts = readFileSync(join(ROOT, 'public/product-facts.json'), 'utf8');
    const freshRelayFacts = readFileSync(join(ROOT, 'scripts/shared/product-facts.generated.json'), 'utf8');
    const freshLocales = readProLocaleFiles();

    assert.equal(currentProducts, freshProducts, 'products.generated.ts is stale — run: npm run product:facts');
    assert.equal(currentProductIds, freshProductIds, 'product-ids.generated.ts is stale — run: npm run product:facts');
    assert.equal(currentTiers, freshTiers, 'tiers.json is stale — run: npm run product:facts');

    assert.equal(currentEdgeCatalog, freshEdgeCatalog, '_product-catalog.generated.js is stale — run: npm run product:facts');
    assert.equal(currentSharedCatalog, freshSharedCatalog, 'product-catalog.generated.json is stale — run: npm run product:facts');
    assert.equal(currentRelayCatalog, freshRelayCatalog, 'scripts/shared product catalog is stale — run: npm run product:facts');
    assert.equal(currentPublicFacts, freshPublicFacts, 'product-facts.json is stale — run: npm run product:facts');
    assert.equal(currentRelayFacts, freshRelayFacts, 'scripts/shared product facts are stale — run: npm run product:facts');
    assert.deepEqual(currentLocales, freshLocales, 'pro locale pricing feature placeholders are stale — run: npm run product:facts');
  });

  it('every currentForCheckout catalog entry appears in generated products', () => {
    // Reverse check: catalog → generated. Catches generator silently dropping entries.
    const freshProducts = readFileSync(join(ROOT, 'src/config/products.generated.ts'), 'utf8');
    const allGeneratedIds = [...freshProducts.matchAll(/'(wm_[^']+)'/g)].map(m => m[1]);

    // Read catalog entries that should be in generated (currentForCheckout with a providerPriceId)
    // Parse from the catalog source file since we can't import TS
    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const checkoutBlocks = catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1);
    for (const block of checkoutBlocks) {
      const hasCheckout = block.includes('currentForCheckout: true');
      const idMatch = block.match(/providerPriceId:\s*["']([^"']+)["']/);
      if (hasCheckout && idMatch) {
        assert.ok(
          allGeneratedIds.includes(idMatch[1]),
          `Catalog entry with providerPriceId ${idMatch[1]} has currentForCheckout=true but is missing from products.generated.ts`,
        );
      }
    }
  });

  it('every publicVisible tier group appears in generated tiers.json', () => {
    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const tierNames = tiersJson.map(t => t.name);

    // Extract publicVisible tier groups from catalog
    const blocks = catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1);
    const visibleGroups = new Set();
    for (const block of blocks) {
      if (block.includes('publicVisible: true')) {
        const groupMatch = block.match(/tierGroup:\s*["']([^"']+)["']/);
        if (groupMatch) visibleGroups.add(groupMatch[1]);
      }
    }

    // Each visible group should have a corresponding tier in the JSON
    // Map group names to expected display names
    const groupToName = { free: 'Free', pro: 'Pro', api_starter: 'API', api_business: 'API Business', enterprise: 'Enterprise' };
    for (const group of visibleGroups) {
      const expectedName = groupToName[group] || group;
      assert.ok(
        tierNames.includes(expectedName),
        `Catalog tier group "${group}" is publicVisible but missing from tiers.json (expected name: "${expectedName}")`,
      );
    }
  });

  it('generated fallback prices have entries for all self-serve products', () => {
    const generatedCatalog = JSON.parse(
      readFileSync(join(ROOT, 'shared/product-catalog.generated.json'), 'utf8'),
    );
    const fallbackIds = Object.keys(generatedCatalog.fallbackPrices);

    // Every self-serve product with a price should have a fallback
    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const blocks = catalogSrc.split(/\n\s*\w+:\s*\{/).slice(1);
    for (const block of blocks) {
      const isSelfServe = block.includes('selfServe: true');
      const idMatch = block.match(/providerPriceId:\s*["']([^"']+)["']/);
      const priceMatch = block.match(/priceCents:\s*(\d+)/);
      if (isSelfServe && idMatch && priceMatch && Number(priceMatch[1]) > 0) {
        assert.ok(
          fallbackIds.includes(idMatch[1]),
          `Self-serve product ${idMatch[1]} missing from generated fallback prices`,
        );
      }
    }
  });
});

describe('Product ID guard', () => {
  it('ignores a file deleted after directory enumeration', () => {
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const results = collectRawProductIds(ROOT, {
      readdir: () => ['gone.mjs'],
      stat: () => { throw missing; },
    });

    assert.deepEqual(results, []);
  });

  it('does not suppress stable-source read errors', () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    assert.throws(
      () => collectRawProductIds(ROOT, {
        readdir: () => ['unreadable.mjs'],
        stat: () => ({ isDirectory: () => false }),
        readFile: () => { throw denied; },
      }),
      /permission denied/,
    );
  });

  it('ignores generated build artifacts', () => {
    const distDir = join(ROOT, 'dist');
    const builtAsset = join(distDir, 'panel.js');
    const results = collectRawProductIds(ROOT, {
      readdir: (path) => path === ROOT ? ['dist'] : ['panel.js'],
      stat: (path) => ({ isDirectory: () => path === distDir }),
      readFile: (path) => {
        assert.equal(path, builtAsset);
        return "const productId = 'wm_pro_monthly';";
      },
    }, ['wm_pro_monthly']);

    assert.deepEqual(results, []);
  });

  it('no raw price lookup keys outside allowed paths', () => {
    const catalogSrc = readFileSync(join(ROOT, 'convex/config/productCatalog.ts'), 'utf8');
    const lookupKeys = [...catalogSrc.matchAll(CATALOG_LOOKUP_KEY_PATTERN)].map((m) => m[1]);
    assert.ok(lookupKeys.length >= 4, `expected the catalog to declare lookup keys, found ${lookupKeys.length}`);

    const results = collectRawProductIds(ROOT, {}, lookupKeys);

    if (results.length > 0) {
      assert.fail(
        `Found raw price lookup keys outside allowed paths. These should import from the catalog:\n${results.join('\n')}`,
      );
    }
  });

  it('no Dodo pdt_ ids survive anywhere in the tree', () => {
    // The catalog moved off Dodo product ids on 2026-08-05. A `pdt_` left in a
    // handler would reach a provider that no longer knows it.
    const results = collectRawProductIds(ROOT, {}, ['pdt_']);

    if (results.length > 0) {
      assert.fail(`Found leftover Dodo product ids:\n${results.join('\n')}`);
    }
  });
});
