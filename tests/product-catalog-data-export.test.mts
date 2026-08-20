// Guards the Pro catalog entries and the `dataExport` entitlement flag.
// `dataExport` controls the locked state and `exportFormats` controls the
// unlocked export actions. These assertions are the source-of-truth guard for
// both, mirroring the apiDailyAllowance guard in
// product-catalog-api-allowance.test.mts.
//
// This file used to guard a separate Pro Business tier. Pro and Pro Business
// merged on 2026-08-05 — same tier, same gates, $10 apart — so Pro now carries
// what Pro Business carried, and export is a Pro feature.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getEntitlementFeatures,
  PLAN_PRECEDENCE,
  PRODUCT_CATALOG,
} from '../convex/config/productCatalog.ts';

const PRO_KEYS = ['pro_monthly', 'pro_annual'];

describe('Pro catalog entries', () => {
  it('pro_monthly carries the agreed feature set', () => {
    const features = getEntitlementFeatures('pro_monthly');
    assert.equal(features.tier, 1);
    assert.equal(features.apiAccess, false, 'must never leak wm_ API key issuance');
    assert.equal(features.apiRateLimit, 0);
    assert.equal(features.apiDailyAllowance, 0);
    assert.equal(features.maxDashboards, 25);
    assert.equal(features.prioritySupport, true);
    assert.equal(features.mcpAccess, true);
    assert.equal(features.dataExport, true);
    assert.deepEqual(features.planLimits, {
      apiRequestsPerDay: 0,
      apiBurstRequestsPerMinute: 0,
      mcpCallsPerDay: 250,
      mcpBurstRequestsPerMinute: 60,
      dashboardAiCallsPerDay: 2_500,
    });
    assert.deepEqual(features.exportFormats, ['csv', 'json', 'pdf']);
  });

  it('pro_annual shares the monthly feature set', () => {
    assert.equal(getEntitlementFeatures('pro_annual'), getEntitlementFeatures('pro_monthly'));
  });

  it('prices the tier at $29/mo and $290/yr', () => {
    assert.equal(PRODUCT_CATALOG.pro_monthly.priceCents, 2900);
    assert.equal(PRODUCT_CATALOG.pro_annual.priceCents, 29000);
  });

  it('is purchasable and published on /pro', () => {
    for (const planKey of PRO_KEYS) {
      const entry = PRODUCT_CATALOG[planKey];
      assert.ok(entry, `${planKey} must exist in the catalog`);
      assert.equal(entry.tierGroup, 'pro');
      assert.equal(entry.publicVisible, true, `${planKey} must stay on the public pricing surfaces`);
      assert.equal(entry.currentForCheckout, true, `${planKey} must be purchasable`);
    }
  });

  it('no longer sells Pro Business under any key', () => {
    // The merge removed both variants. A catalog that grows one back is a
    // pricing-page regression, not a new feature.
    for (const planKey of Object.keys(PRODUCT_CATALOG)) {
      assert.ok(
        !planKey.startsWith('pro_business'),
        `${planKey} resurrects the retired Pro Business tier`,
      );
    }
    assert.throws(() => getEntitlementFeatures('pro_business_monthly'), /Unknown planKey/);
  });

  it('still throws on an unknown planKey (the tierGroup is not one)', () => {
    assert.throws(() => getEntitlementFeatures('pro'), /Unknown planKey/);
  });
});

describe('dataExport is the export enforcement field', () => {
  it('every catalog entry sets dataExport explicitly (no undefined in source-of-truth rows)', () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      assert.equal(
        typeof entry.features.dataExport,
        'boolean',
        `${planKey} must set dataExport explicitly`,
      );
    }
  });

  it('grants export to every paid tier and denies Free', () => {
    assert.equal(getEntitlementFeatures('free').dataExport, false);
    assert.equal(getEntitlementFeatures('pro_monthly').dataExport, true);
    assert.equal(getEntitlementFeatures('pro_annual').dataExport, true);
    assert.equal(getEntitlementFeatures('api_starter').dataExport, true);
    assert.equal(getEntitlementFeatures('api_starter_annual').dataExport, true);
    assert.equal(getEntitlementFeatures('api_business').dataExport, true);
    assert.equal(getEntitlementFeatures('enterprise').dataExport, true);
  });

  it('exportFormats agrees with dataExport and the menu capabilities it grants', () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      const { dataExport, exportFormats } = entry.features;
      assert.deepEqual(
        exportFormats,
        dataExport ? ['csv', 'json', 'pdf'] : [],
        `${planKey} advertises the formats its dataExport flag actually grants`,
      );
    }
  });
});

describe('PLAN_PRECEDENCE covers the paid tiers', () => {
  it('ranks both Pro variants above Free and below API', () => {
    for (const planKey of PRO_KEYS) {
      const precedence = PLAN_PRECEDENCE[planKey];
      assert.equal(typeof precedence, 'number', `${planKey} needs a PLAN_PRECEDENCE entry`);
      assert.ok(
        precedence > PLAN_PRECEDENCE.free,
        `${planKey} (${precedence}) must outrank free (${PLAN_PRECEDENCE.free})`,
      );
      assert.ok(
        precedence < PLAN_PRECEDENCE.api_starter,
        `${planKey} (${precedence}) must rank below api_starter (${PLAN_PRECEDENCE.api_starter})`,
      );
    }
    assert.ok(
      PLAN_PRECEDENCE.pro_annual > PLAN_PRECEDENCE.pro_monthly,
      'the longer commitment outranks monthly at the same tier',
    );
  });

  it('covers every catalog planKey (a missing entry silently degrades to 0)', () => {
    for (const planKey of Object.keys(PRODUCT_CATALOG)) {
      assert.equal(
        typeof PLAN_PRECEDENCE[planKey],
        'number',
        `${planKey} is in PRODUCT_CATALOG but missing from PLAN_PRECEDENCE`,
      );
    }
  });
});
