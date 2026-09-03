/**
 * Locks the duplicate-subscription (409) dialog copy.
 *
 * One shape now: "you're already subscribed, manage it in the portal". The
 * guided cancel-then-rebuy variant existed for exactly one pairing the portal
 * could not perform — Pro → Pro Business, two separate products rather than an
 * updatable collection. Pro Business merged into Pro on 2026-08-05, so no
 * blocked pairing is left that the portal cannot handle, and the copy that
 * walked a buyer through cancelling went with it.
 *
 * Pure-function test: the DOM rendering is the shared checkout-dialog-factory
 * scaffold, covered by parity with the sibling dialogs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDuplicateSubscriptionBody } from '../src/services/checkout-duplicate-dialog.ts';

describe('buildDuplicateSubscriptionBody', () => {
  it('names the plan the account already holds', () => {
    const body = buildDuplicateSubscriptionBody({ planDisplayName: 'Pro Monthly' });
    assert.equal(
      body,
      "Your account already has an active Pro Monthly subscription. Open the billing portal to manage it — you won't be charged twice.",
    );
  });

  it('reads the same way for an API plan', () => {
    const body = buildDuplicateSubscriptionBody({ planDisplayName: 'API Monthly' });
    assert.ok(body.includes('API Monthly'));
    assert.ok(body.includes('billing portal'));
  });

  it('still produces a coherent sentence with the fallback plan name', () => {
    // checkout-plan-names.ts returns "Pro" for any planKey this build does not
    // know, so the sentence has to survive that word standing in for a tier.
    const body = buildDuplicateSubscriptionBody({ planDisplayName: 'Pro' });
    assert.ok(body.startsWith('Your account already has an active Pro subscription.'));
  });
});

describe('cross-app copy parity (dashboard dialog vs /pro dialog)', () => {
  // pro-test/ is a sealed Vite app with no import path back to src/, so its
  // proDuplicateBodyHtml hand-mirrors buildDuplicateSubscriptionBody. This
  // guard pins the shared sentence in BOTH sources so the two surfaces cannot
  // silently diverge (same pattern as the i18n/docs-stats parity gates).
  it('both dialog sources carry the portal sentence', async () => {
    const dashboardBody = buildDuplicateSubscriptionBody({ planDisplayName: 'Pro' });
    const { readFile } = await import('node:fs/promises');
    const proSrc = await readFile('pro-test/src/services/checkout.ts', 'utf8');
    const shared = "Open the billing portal to manage it — you won't be charged twice.";
    assert.ok(dashboardBody.includes(shared), 'dashboard dialog lost the portal sentence');
    assert.ok(proSrc.includes(shared), '/pro dialog lost the portal sentence');
  });
});
