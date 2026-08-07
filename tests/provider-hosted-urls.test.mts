/**
 * Open-redirect guard for the provider-hosted pages we navigate buyers to
 * (#4449).
 *
 * `safeHostedCheckoutUrl` gates the `window.location.assign` in redirect-mode
 * checkout and `safeBillingPortalUrl` gates the tab the billing portal opens
 * into, so their rejection branches are security-critical: a server response
 * that ever carried an unexpected origin, an http downgrade, a `javascript:`
 * URL, or a non-string must NOT navigate the buyer anywhere.
 *
 * The two lists are asserted against each other as well as against attacker
 * strings: a checkout URL must not pass the portal guard and the reverse,
 * because each guard fronts a different navigation and neither host serves the
 * other's sessions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeBillingPortalUrl, safeHostedCheckoutUrl } from '../src/services/provider-hosted-urls.ts';

describe('safeHostedCheckoutUrl', () => {
  it('accepts a live checkout session URL', () => {
    const url = 'https://checkout.stripe.com/c/pay/cs_live_abcdefghijklmnopqrstuv';
    assert.equal(safeHostedCheckoutUrl(url), url);
  });

  // Stripe serves test and live sessions from one host — the session id carries
  // the mode. There is no second origin to allow, so a test-mode URL has to pass
  // the same single-entry list a live one does.
  it('accepts a test-mode checkout session URL on the same host', () => {
    const url = 'https://checkout.stripe.com/c/pay/cs_test_abcdefghijklmnopqrstuv';
    assert.equal(safeHostedCheckoutUrl(url), url);
  });

  it('accepts a plain payment-link path on the hosted origin', () => {
    const url = 'https://checkout.stripe.com/b/Z3okzwYA';
    assert.equal(safeHostedCheckoutUrl(url), url);
  });

  it('rejects a non-HTTPS (http) downgrade on the hosted origin', () => {
    assert.equal(safeHostedCheckoutUrl('http://checkout.stripe.com/c/pay/cs_test_x'), null);
  });

  it('rejects a third-party host', () => {
    assert.equal(safeHostedCheckoutUrl('https://evil.com/c/pay/cs_test_x'), null);
  });

  it('rejects a look-alike suffix host (checkout.stripe.com.evil.com)', () => {
    assert.equal(safeHostedCheckoutUrl('https://checkout.stripe.com.evil.com/x'), null);
  });

  it('rejects an unlisted subdomain of the checkout domain', () => {
    assert.equal(safeHostedCheckoutUrl('https://evil.checkout.stripe.com/x'), null);
  });

  it('rejects the bare provider domain', () => {
    assert.equal(safeHostedCheckoutUrl('https://stripe.com/c/pay/cs_test_x'), null);
  });

  it('rejects the billing portal host', () => {
    assert.equal(safeHostedCheckoutUrl('https://billing.stripe.com/p/session/x'), null);
  });

  it('rejects a javascript: URL', () => {
    assert.equal(safeHostedCheckoutUrl('javascript:alert(1)'), null);
  });

  it('rejects an unparseable / non-URL string', () => {
    assert.equal(safeHostedCheckoutUrl('not a url'), null);
    assert.equal(safeHostedCheckoutUrl(''), null);
  });

  it('rejects non-string inputs', () => {
    assert.equal(safeHostedCheckoutUrl(null), null);
    assert.equal(safeHostedCheckoutUrl(undefined), null);
    assert.equal(safeHostedCheckoutUrl(42), null);
    assert.equal(safeHostedCheckoutUrl({ toString: () => 'https://checkout.stripe.com/x' }), null);
  });
});

describe('safeBillingPortalUrl', () => {
  it('accepts a portal session URL', () => {
    const url = 'https://billing.stripe.com/p/session/test_YWNjdF8xAbCdEf';
    assert.equal(safeBillingPortalUrl(url), url);
  });

  it('accepts a portal login-link URL', () => {
    const url = 'https://billing.stripe.com/p/login/8wMbJTdOK5Kw2VW288';
    assert.equal(safeBillingPortalUrl(url), url);
  });

  it('rejects a non-HTTPS (http) downgrade on the portal origin', () => {
    assert.equal(safeBillingPortalUrl('http://billing.stripe.com/p/session/x'), null);
  });

  it('rejects a look-alike suffix host (billing.stripe.com.evil.com)', () => {
    assert.equal(safeBillingPortalUrl('https://billing.stripe.com.evil.com/x'), null);
  });

  it('rejects an unlisted subdomain of the portal domain', () => {
    assert.equal(safeBillingPortalUrl('https://evil.billing.stripe.com/x'), null);
  });

  it('rejects the checkout host', () => {
    assert.equal(safeBillingPortalUrl('https://checkout.stripe.com/c/pay/cs_test_x'), null);
  });

  it('rejects a javascript: URL', () => {
    assert.equal(safeBillingPortalUrl('javascript:alert(1)'), null);
  });

  it('rejects non-string inputs', () => {
    assert.equal(safeBillingPortalUrl(null), null);
    assert.equal(safeBillingPortalUrl(undefined), null);
    assert.equal(safeBillingPortalUrl(42), null);
  });
});
