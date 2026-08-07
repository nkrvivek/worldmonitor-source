/**
 * Conversion-funnel instrumentation policy (#4931).
 *
 * Source-extraction guards (same pattern as other policy tests): these
 * invariants are cheap to delete silently in a refactor and expensive to
 * notice — each one going missing blinds a segment of the funnel without
 * breaking any runtime behavior.
 *
 *  1. The tracker must keep no hostname allowlist. The hosted Umami script it
 *     replaced compared the current hostname against a fixed list and switched
 *     itself off outside it, which is how this host came to record nothing.
 *  2. The typed event catalog must contain the funnel events.
 *  3. startCheckout (dashboard) fires checkout-start; the checkout-return
 *     reconciliation fires checkout-success / checkout-failed.
 *  4. The /pro SPA and welcome landing must carry the inline tracker with the
 *     static CSP nonce, and the /pro checkout service must fire checkout-start
 *     for both the direct and post-sign-in resume paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const { trackApiAction } = await import('../src/services/analytics.ts');

test('the tracker has no hostname allowlist to fall outside of', () => {
  const tracker = read('src/services/analytics-tracker.ts');
  // Comments off first: the file explains in prose which host it replaced, and
  // what matters is that no host name reaches the code.
  const code = tracker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/data-domains|worldmonitor\.app/.test(code),
    'the tracker names a host again — a hostname allowlist is what killed analytics here');
  assert.ok(tracker.includes("export const ANALYTICS_COLLECTOR_PATH = '/api/send'"),
    'collector path changed — it must stay a same-origin path, and match the gate exactly');
});

test('funnel events exist in the typed catalog', () => {
  const src = read('src/services/analytics.ts');
  for (const ev of ['checkout-start', 'checkout-success', 'checkout-failed', 'api-action']) {
    assert.ok(src.includes(`'${ev}': true`), `event '${ev}' missing from EVENTS catalog`);
  }
});

test('API outcome telemetry is bounded to successful key lifecycle actions', () => {
  const analytics = read('src/services/analytics.ts');
  const settings = read('src/components/UnifiedSettings.ts');
  assert.ok(analytics.includes("['key-created', 'key-revoked'] as const"),
    'API action vocabulary must stay closed to key lifecycle outcomes');
  assert.ok(analytics.includes("track('api-action', { action })"),
    'API action helper must emit only the normalized action bucket');
  assert.ok(settings.includes("trackApiAction('key-created')"),
    'successful API key creation no longer contributes to API outcomes');
  assert.ok(settings.includes("trackApiAction('key-revoked')"),
    'successful API key revocation no longer contributes to API outcomes');
  assert.ok(!settings.includes('trackApiAction(keyId)'),
    'API telemetry must not include a key identifier');
});

test('API outcome telemetry emits only the closed key lifecycle buckets at runtime', () => {
  const calls = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      umami: {
        track: (event, data) => calls.push({ event, data }),
      },
    },
  });

  try {
    trackApiAction('key-created');
    trackApiAction('key-revoked');
    // The TypeScript signature protects typed callers; this exercises the
    // runtime boundary where an untyped or stale caller can still arrive.
    trackApiAction('key-exported');

    assert.deepEqual(calls, [
      { event: 'api-action', data: { action: 'key-created' } },
      { event: 'api-action', data: { action: 'key-revoked' } },
    ]);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      delete globalThis.window;
    }
  }
});

test('dashboard checkout entry fires checkout-start', () => {
  const src = read('src/services/checkout.ts');
  assert.ok(src.includes('trackCheckoutStart(productId'),
    'startCheckout no longer fires trackCheckoutStart — funnel start is blind');
});

test('checkout-return reconciliation fires success/failed events', () => {
  const src = read('src/app/panel-layout.ts');
  assert.ok(src.includes('trackCheckoutSuccess('),
    'checkout-return success path no longer fires trackCheckoutSuccess');
  assert.ok(src.includes('trackCheckoutFailed('),
    'checkout-return failed path no longer fires trackCheckoutFailed');
});

test('/pro and welcome pages carry the inline tracker (collector + nonce)', () => {
  // Both the source pages and the built artifacts the Worker serves. They are
  // hand-kept in step, so a swap applied to one and not the other ships a page
  // with no analytics on it.
  for (const page of ['pro-test/index.html', 'pro-test/welcome.html',
    'public/pro/index.html', 'public/pro/welcome.html']) {
    const html = read(page);
    assert.ok(!/<script[^>]+abacus\.worldmonitor\.app\/script\.js/.test(html),
      `${page}: the hosted Umami script is back — it self-disables on this host and records nothing`);
    const tracker = html.match(/<script nonce="wm-static-bootstrap">\s*\(function \(\) \{\s*var KEY = 'wm-analytics-session'[\s\S]*?<\/script>/);
    assert.ok(tracker, `${page}: inline tracker missing — the page sends no analytics at all`);
    assert.ok(tracker[0].includes("fetch('/api/send'"),
      `${page}: tracker no longer posts to the collector`);
    assert.ok(tracker[0].includes('window.umami = {'),
      `${page}: window.umami surface gone — the /pro checkout funnel polls for it and would queue forever`);
    assert.ok(tracker[0].includes("send('event', { name: 'pageview' })"),
      `${page}: pageview no longer fires`);
    assert.ok(tracker[0].includes('[data-umami-event]'),
      `${page}: CTA click delegation gone — data-umami-event markup would go unread`);
  }
});

test('/pro and welcome entries initialize DebugBear RUM', () => {
  for (const entry of ['pro-test/src/main.tsx', 'pro-test/src/welcome-main.tsx']) {
    const src = read(entry);
    assert.ok(
      src.includes("import { initDebugBearRum } from './debugbear-rum'"),
      `${entry}: DebugBear RUM import missing`,
    );
    assert.ok(src.includes('initDebugBearRum();'), `${entry}: DebugBear RUM init missing`);
  }
});

test('/pro checkout service fires checkout-start on both paths', () => {
  const src = read('pro-test/src/services/checkout.ts');
  // Round-2 F4 (Greptile): asserting only the surface labels would still
  // pass if the trackFunnelEvent calls were deleted around them. Extract
  // the actual checkout-start emissions and check each surface is wired
  // to one.
  const emissions = src.match(/trackFunnelEvent\(\s*'checkout-start'[\s\S]{0,300}?\}\s*\)/g) ?? [];
  assert.ok(emissions.some((call) => call.includes("'pro-page'")),
    "no trackFunnelEvent('checkout-start', …surface:'pro-page') emission in startCheckout");
  assert.ok(emissions.some((call) => call.includes("'pro-resume'")),
    "no trackFunnelEvent('checkout-start', …surface:'pro-resume') emission in tryResumeCheckoutFromUrl");
});

test('no page or tracker sends the query string', () => {
  // The hosted script needed data-exclude-search to be told this. Ours sends
  // location.pathname and has no way to reach the search params, on any
  // surface — /pro puts checkout intent (wm_checkout_*) and the auth handshake
  // there, and the dashboard puts share tokens there.
  for (const page of ['pro-test/index.html', 'pro-test/welcome.html',
    'public/pro/index.html', 'public/pro/welcome.html']) {
    const tracker = read(page).match(/<script nonce="wm-static-bootstrap">\s*\(function \(\) \{\s*var KEY = 'wm-analytics-session'[\s\S]*?<\/script>/)[0];
    assert.ok(tracker.includes('url: location.pathname'),
      `${page}: tracker no longer sends the path alone`);
    assert.ok(!/location\.(search|href)/.test(tracker),
      `${page}: tracker reads the query string`);
  }
  const tracker = read('src/services/analytics-tracker.ts');
  assert.ok(!/location\.(search|href)/.test(tracker),
    'dashboard tracker reads the query string');
});

test('checkout-success is durable across the entitlement reload', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('sessionStorage.setItem(CHECKOUT_SUCCESS_PENDING_KEY'),
    'trackCheckoutSuccess no longer writes the durable marker');
  assert.ok(analytics.includes('clearPendingCheckoutSuccessMarker()'),
    'delivery-time marker clear missing from sendAnalyticsCall');
  const layout = read('src/app/panel-layout.ts');
  assert.ok(layout.includes('replayPendingCheckoutSuccess()'),
    'panel-layout boot no longer replays a pending checkout-success');
});

test('checkout-failed status is bucketed to a closed vocabulary', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('CHECKOUT_FAILED_STATUSES.has(rawStatus)'),
    'trackCheckoutFailed no longer normalizes the URL-derived status — unbounded cardinality');
});

test('checkout-start product ids are bucketed on both surfaces (round-4 F2)', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('bucketProductIdForAnalytics(productId)'),
    'dashboard trackCheckoutStart no longer buckets the (resume-path URL-derived) productId');
  assert.ok(analytics.includes("from '@/config/product-ids.generated'") && analytics.includes('DODO_PRODUCT_IDS'),
    'dashboard product allowlist must keep deriving from the generated catalog');
  const pro = read('pro-test/src/services/checkout.ts');
  const emissions = pro.match(/trackFunnelEvent\(\s*'checkout-start'[\s\S]{0,300}?\}\s*\)/g) ?? [];
  assert.equal(emissions.length, 2, 'expected exactly two /pro checkout-start emissions');
  for (const call of emissions) {
    assert.ok(call.includes('bucketProductIdForAnalytics('),
      `/pro checkout-start emission no longer buckets productId: ${call.slice(0, 80)}…`);
  }
});

test('/pro funnel events queue until the async tracker loads (round-4 F3)', () => {
  const pro = read('pro-test/src/services/checkout.ts');
  assert.ok(pro.includes('pendingFunnelEvents'),
    '/pro trackFunnelEvent no longer queues — the mount-time pro-resume event drops when the async tracker has not loaded');
  assert.ok(pro.includes('FUNNEL_FLUSH_MAX_ATTEMPTS'),
    '/pro funnel flush poll no longer bounded');
});

test('/pro startCheckout has a synchronous re-entrancy guard (round-4 F4)', () => {
  const pro = read('pro-test/src/services/checkout.ts');
  assert.ok(pro.includes('startCheckoutEntryInFlight'),
    'rapid double-clicks double-fire checkout-start without the whole-start guard');
});

test('/pro checkout-start survives the hosted-checkout redirect via sessionStorage handoff (round-5)', () => {
  const pro = read('pro-test/src/services/checkout.ts');
  assert.ok(pro.includes("'wm-pro-funnel-pending'"),
    '/pro no longer persists undelivered checkout-start — the fast signed-in path dies with the redirect');
  assert.ok(
    pro.includes('persistFunnelEventForReplay(event, data)')
      || pro.includes('persistFunnelEventForReplay(event, enrichedData)'),
    '/pro queue branch no longer mirrors events into sessionStorage',
  );
  assert.ok(pro.includes('clearPersistedFunnelEvents()'),
    '/pro flush no longer clears the mirror — delivered events would double-replay on the dashboard');
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes("'wm-pro-funnel-pending'"),
    'dashboard replay no longer reads the /pro handoff key (keys must match across builds)');
  const layout = read('src/app/panel-layout.ts');
  assert.ok(layout.includes('replayPendingProFunnelEvents()'),
    'panel-layout boot no longer replays /pro funnel events');
});

test('/pro replay marker clears on DELIVERY, not on read (round-6)', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes("call.data?.replayed === true"),
    'sendAnalyticsCall no longer clears the pro-funnel marker on confirmed replay delivery');
  assert.ok(analytics.includes('clearPendingProFunnelMarker()'),
    'delivery-time pro-funnel marker clear is missing');
  assert.ok(analytics.includes('JSON.stringify(sanitized.map'),
    'replay no longer rewrites the marker with sanitized survivors — a pre-delivery reload would retry raw junk or nothing');
});
