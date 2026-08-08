/**
 * Locks the plan-name whitelist. Reasons:
 *   1. Safety: the 409 server payload's `subscription.planKey` is
 *      technically "just a string from the server" — the dialog uses
 *      this function as the guard that prevents arbitrary server text
 *      from reaching the user.
 *   2. Forward compat: if Dodo adds a new planKey before this client
 *      ships to match, the fallback "Pro" must still render something
 *      coherent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePlanDisplayName,
  KNOWN_PLAN_KEYS,
} from '../src/services/checkout-plan-names.ts';

describe('resolvePlanDisplayName', () => {
  it('maps pro_monthly to "Pro Monthly"', () => {
    assert.equal(resolvePlanDisplayName('pro_monthly'), 'Pro Monthly');
  });

  it('maps pro_annual to "Pro Annual"', () => {
    assert.equal(resolvePlanDisplayName('pro_annual'), 'Pro Annual');
  });

  // The key stayed `api_starter` when the plan was renamed to "API" on
  // 2026-08-05; the name a buyer reads and the key we store are not the same
  // string, and this test is where that is written down.
  it('maps api_starter to "API Monthly"', () => {
    assert.equal(resolvePlanDisplayName('api_starter'), 'API Monthly');
  });

  it('maps api_starter_annual to "API Annual"', () => {
    assert.equal(resolvePlanDisplayName('api_starter_annual'), 'API Annual');
  });

  it('maps api_business to "API Business"', () => {
    assert.equal(resolvePlanDisplayName('api_business'), 'API Business');
  });

  it('maps api_business_annual to "API Business Annual"', () => {
    assert.equal(resolvePlanDisplayName('api_business_annual'), 'API Business Annual');
  });

  it('falls back to "Pro" for unknown planKey', () => {
    assert.equal(resolvePlanDisplayName('new_tier_2027'), 'Pro');
  });

  it('falls back to "Pro" for undefined', () => {
    assert.equal(resolvePlanDisplayName(undefined), 'Pro');
  });

  it('falls back to "Pro" for null', () => {
    assert.equal(resolvePlanDisplayName(null), 'Pro');
  });

  it('falls back to "Pro" for empty string', () => {
    assert.equal(resolvePlanDisplayName(''), 'Pro');
  });

  it('falls back to "Pro" for non-string input', () => {
    assert.equal(resolvePlanDisplayName(42), 'Pro');
    assert.equal(resolvePlanDisplayName({ planKey: 'pro_monthly' }), 'Pro');
    assert.equal(resolvePlanDisplayName(true), 'Pro');
  });

  it('never returns server-provided text for unknown keys', () => {
    // Even if the server sends a plausible-looking string, we don't
    // render it — this is the privacy/safety invariant.
    const hostile = 'DROP TABLE users; --';
    const result = resolvePlanDisplayName(hostile);
    assert.ok(!result.includes('DROP'));
    assert.ok(!result.includes('users'));
    assert.equal(result, 'Pro');
  });

  it('whitelist covers all 6 shipped paid plan keys', () => {
    // Smoke check so a future rename or removal is caught here rather
    // than silently producing "Pro" for a real tier.
    assert.ok(KNOWN_PLAN_KEYS.includes('pro_monthly'));
    assert.ok(KNOWN_PLAN_KEYS.includes('pro_annual'));
    assert.ok(KNOWN_PLAN_KEYS.includes('api_starter'));
    assert.ok(KNOWN_PLAN_KEYS.includes('api_starter_annual'));
    assert.ok(KNOWN_PLAN_KEYS.includes('api_business'));
    assert.ok(KNOWN_PLAN_KEYS.includes('api_business_annual'));
    assert.equal(KNOWN_PLAN_KEYS.length, 6);
  });
});
