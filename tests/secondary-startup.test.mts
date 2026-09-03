import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dashboardFontFamilies } from '../src/bootstrap/secondary-startup.ts';
import { scheduleAfterFirstPaint } from '../src/utils/after-paint.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const dashboardCsp = vercelConfig.headers
  .find((entry: { source: string }) => entry.source === '/((?!docs|embed|embed\\.html).*)')
  ?.headers
  ?.find((header: { key: string }) => header.key === 'Content-Security-Policy')
  ?.value ?? '';
const activeMarkup = indexHtml.replace(/<!--[\s\S]*?-->/g, '');

describe('secondary dashboard startup', () => {
  it('keeps analytics, auth, Sentry, and font fetches out of index.html startup tags', () => {
    assert.equal(
      /<script\b[^>]+src=["']https:\/\/abacus\.worldmonitor\.app\/script\.js["']/i.test(activeMarkup),
      false,
      'The hosted Umami script is gone -- analytics ship in the bundle now',
    );
    assert.equal(
      /<script\b[^>]+src=["']https:\/\/cdn\.debugbear\.com\/lpMwA9KpC6pf\.js["']/i.test(activeMarkup),
      false,
      'DebugBear RUM must be injected by the dashboard loader, not index.html',
    );
    assert.equal(
      /<link\b[^>]+rel=["']preconnect["'][^>]+href=["']https:\/\/o4509927897890816\.ingest\.us\.sentry\.io["']/i.test(activeMarkup),
      false,
      'Sentry ingest preconnect must not compete with initial dashboard paint',
    );
    assert.equal(
      /<link\b[^>]+rel=["'](?:dns-prefetch|preconnect)["'][^>]+href=["']https:\/\/[^"']*\.supabase\.co["']/i.test(activeMarkup),
      false,
      'Auth host must not be prefetched before the deferred auth loader',
    );
    assert.equal(
      /<link\b[^>]+href=["']https:\/\/fonts\.googleapis\.com\/css2\?/i.test(activeMarkup),
      false,
      'Google Fonts stylesheet must not be an eager head request',
    );
    assert.equal(
      /<link\b[^>]+rel=["']preconnect["'][^>]+href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com["']/i.test(activeMarkup),
      false,
      'Google Fonts preconnects must be deferred with the narrowed font request',
    );
  });

  it('keeps secondary startup script hosts out of the dashboard script-src allowlist', () => {
    const scriptSrc = dashboardCsp.match(/script-src\s+([^;]+)/)?.[1] ?? '';
    assert.match(scriptSrc, /'strict-dynamic'/);
    assert.doesNotMatch(scriptSrc, /https:\/\/abacus\.worldmonitor\.app/);
    assert.doesNotMatch(scriptSrc, /https:\/\/cdn\.debugbear\.com/);
    assert.doesNotMatch(scriptSrc, /https:\/\/static\.cloudflareinsights\.com/);
    assert.doesNotMatch(dashboardCsp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(dashboardCsp, /font-src[^;]*'self'/);
    assert.doesNotMatch(dashboardCsp, /font-src[^;]*https:/);
  });

  it('does not load any web font for the default English dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'full', lang: 'en', dir: '' }), []);
  });

  it('loads only Nunito for the happy dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'happy', lang: 'en', dir: '' }), ['nunito']);
  });

  it('loads only Tajawal for the Arabic dashboard, not happy fonts', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'full', lang: 'ar', dir: 'rtl' }), ['tajawal']);
  });

  it('combines Nunito + Tajawal for the Arabic happy dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'happy', lang: 'ar', dir: 'rtl' }), ['nunito', 'tajawal']);
  });
});

type FakeUmami = {
  track: (name: string, data?: Record<string, unknown>) => void;
  identify: (data: Record<string, unknown>) => void;
};

interface RecordedRequest {
  url: string;
  method: string;
  body: string;
}

/**
 * Installs the synchronous fake window/document/setTimeout harness the deferred
 * tracker needs (requestAnimationFrame + requestIdleCallback + setTimeout all
 * run their callback inline so scheduleAfterFirstPaint resolves in one tick).
 *
 * `window.fetch` is part of the harness, not an extra: the tracker writes
 * through it and the collector gate wraps it, so a harness without one makes
 * installLocalTracker refuse to install.
 */
function installTrackerHarness(): {
  requests: RecordedRequest[];
  createdElements: string[];
  setUmami: (umami: FakeUmami) => void;
  restore: () => void;
} {
  const requests: RecordedRequest[] = [];
  const createdElements: string[] = [];
  const fakeWindow: Record<string, unknown> = {
    requestAnimationFrame: (cb: () => void) => {
      cb();
      return 1;
    },
    requestIdleCallback: (cb: () => void) => {
      cb();
      return 1;
    },
    fetch: (input: unknown, init?: { method?: string; body?: unknown }) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(
        new Response(JSON.stringify({ cache: 'cache-id', sessionId: 'session-id', visitId: 'visit-id' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
  const fakeDocument = {
    readyState: 'complete',
    querySelector: () => null,
    createElement: (tag: string) => {
      createdElements.push(tag);
      return {};
    },
    head: { appendChild: (node: unknown) => node },
  };
  const saved: Record<string, PropertyDescriptor | undefined> = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  };
  const realSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    value: (cb: () => void) => {
      cb();
      return 1;
    },
  });
  return {
    requests,
    createdElements,
    setUmami: (umami: FakeUmami) => {
      fakeWindow.umami = umami;
    },
    restore: () => {
      Object.defineProperty(globalThis, 'setTimeout', {
        configurable: true,
        value: realSetTimeout,
      });
      for (const [key, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

describe('deferred analytics tracker', () => {
  it('queues dashboard analytics calls and flushes them once the tracker is installed', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installTrackerHarness();
    const calls: Array<{ kind: string; name?: string; data: Record<string, unknown> | undefined }> = [];
    try {
      analytics.track('search-open', { source: 'desktop' });
      analytics.identifyUser('user_1', 'free', null, null);
      analytics.identifyUser('user_1', 'pro', null, null);
      // Installed only now: an identity call made while a tracker is present
      // goes straight out, and this test is about what the QUEUE replays.
      h.setUmami({
        track: (name: string, data?: Record<string, unknown>) => calls.push({ kind: 'track', name, data }),
        identify: (data: Record<string, unknown>) => calls.push({ kind: 'identify', data }),
      });
      await analytics.initAnalytics();

      assert.equal(h.createdElements.length, 0, 'no analytics script is injected any more');
      assert.deepEqual(calls, [
        { kind: 'track', name: 'search-open', data: { source: 'desktop' } },
        { kind: 'identify', data: { userId: 'user_1', plan: 'pro' } },
      ]);
    } finally {
      h.restore();
    }
  });

  it('posts a queued event to this site own collector', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installTrackerHarness();
    try {
      analytics.track('search-open', { source: 'desktop' });
      await analytics.initAnalytics();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(h.requests.length, 1, 'the queued event became exactly one collector write');
      const request = h.requests[0]!;
      assert.equal(request.url, '/api/send');
      assert.equal(request.method, 'POST');
      const body = JSON.parse(request.body) as { type: string; payload: Record<string, unknown> };
      assert.equal(body.type, 'event');
      assert.equal(body.payload.name, 'search-open');
      assert.deepEqual(body.payload.data, { source: 'desktop' });
      assert.equal(typeof body.payload.id, 'string');
      assert.equal(typeof body.payload.visitId, 'string');
    } finally {
      h.restore();
    }
  });
});

describe('scheduleAfterFirstPaint', () => {
  it('runs the task via the load-event listener when readyState is not complete', () => {
    const loadHandlers: Array<() => void> = [];
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      requestIdleCallback: (cb: () => void) => {
        cb();
        return 1;
      },
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'load') loadHandlers.push(cb);
      },
    };
    const fakeDocument = { readyState: 'loading' };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    try {
      let ran = 0;
      scheduleAfterFirstPaint(() => {
        ran += 1;
      });
      assert.equal(ran, 0, 'task must not run before the load event fires');
      assert.equal(loadHandlers.length, 1, 'a load listener must be registered');
      loadHandlers[0]!();
      assert.equal(ran, 1, 'task runs exactly once after load -> rAF -> idle');
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  it('falls back to setTimeout when requestIdleCallback is absent', () => {
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      addEventListener: () => {},
    };
    const fakeDocument = { readyState: 'complete' };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const savedSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (cb: () => void) => {
        cb();
        return 1;
      },
    });
    try {
      let ran = 0;
      scheduleAfterFirstPaint(() => {
        ran += 1;
      });
      assert.equal(ran, 1, 'task runs via the setTimeout fallback when rIC is missing');
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      else delete (globalThis as { document?: unknown }).document;
      if (savedSetTimeout) Object.defineProperty(globalThis, 'setTimeout', savedSetTimeout);
    }
  });
});

describe('deferred analytics tracker — failure and edge paths', () => {
  it('installs the tracker once and never a second time', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installTrackerHarness();
    try {
      analytics.initAnalytics();
      const afterFirst = h.requests.length;
      analytics.initAnalytics();
      analytics.track('search-open');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.requests.length, afterFirst + 1, 'a second init adds no second tracker');
    } finally {
      h.restore();
    }
  });

  it('caps the pre-load queue at 50 and evicts the oldest call', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installTrackerHarness();
    const delivered: Array<Record<string, unknown> | undefined> = [];
    try {
      for (let i = 0; i < 51; i++) analytics.track('search-open', { i });
      h.setUmami({
        track: (_name: string, data?: Record<string, unknown>) => delivered.push(data),
        identify: () => {},
      });
      analytics.initAnalytics();
      assert.equal(delivered.length, 50, 'queue caps at 50 and flushes 50');
      assert.deepEqual(delivered[0], { i: 1 }, 'the oldest call (i:0) was evicted');
      assert.deepEqual(delivered[49], { i: 50 });
    } finally {
      h.restore();
    }
  });

  it('queues a call when window.umami.track throws, then delivers it on flush', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installTrackerHarness();
    const delivered: string[] = [];
    let throwOnce = true;
    try {
      h.setUmami({
        track: (name: string) => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error('umami boom');
          }
          delivered.push(name);
        },
        identify: () => {},
      });
      analytics.track('search-open');
      assert.deepEqual(delivered, [], 'a throwing track() is not delivered — it is queued');
      analytics.initAnalytics();
      assert.deepEqual(delivered, ['search-open'], 'the queued call is delivered on flush');
    } finally {
      h.restore();
    }
  });

  it('keeps a tracker something else already installed', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const h = installTrackerHarness();
    const delivered: string[] = [];
    try {
      h.setUmami({
        track: (name: string) => delivered.push(name),
        identify: () => {},
      });
      analytics.track('search-open');
      analytics.initAnalytics();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(delivered, ['search-open'], 'the existing tracker took the queued event');
      assert.equal(h.requests.length, 0, 'ours never replaced it, so no collector write was made');
    } finally {
      h.restore();
    }
  });
});
