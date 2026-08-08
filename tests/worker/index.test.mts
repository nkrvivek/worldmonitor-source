import { describe, expect, test, vi } from 'vitest';
import worker, { type Env } from '../../worker/index';
import type { RequestParts } from '../../worker/routing/resolve';
import { mergeQueryString } from '../../worker/routing/pattern';

/**
 * ASSETS stub: any path in `present` is a hit, everything else is a 404.
 *
 * Locks the request body's stream (without reading it) before answering, the
 * same way a real fetch-shaped ASSETS binding would when handed a request
 * that carries one. This is what makes the body-disturbance bug in
 * worker/index.ts reproducible under vitest/Node: a stub that only reads
 * `request.url` never touches the body, so it can't catch a regression where
 * the asset probe runs before a rewrite needs to re-read that same body.
 */
function envWith(present: string[]): Env {
  return {
    ASSETS: {
      async fetch(request: Request) {
        request.body?.getReader();
        const { pathname } = new URL(request.url);
        return present.includes(pathname)
          ? new Response(`asset:${pathname}`, { status: 200 })
          : new Response('not found', { status: 404 });
      },
    },
    UPSTREAM_API_ORIGIN: 'https://vercel-origin.worldmonitor.app',
  };
}

const get = (url: string) => new Request(url);

describe('worker fetch', () => {
  test('redirects before looking at the filesystem', async () => {
    const env = envWith(['/security.txt']);
    const res = await worker.fetch(get('https://www.worldmonitor.app/security.txt'), env);
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/.well-known/security.txt');
  });

  test('serves a static asset before consulting rewrites', async () => {
    const env = envWith(['/dashboard-tech.html', '/embed.html']);
    const res = await worker.fetch(get('https://www.worldmonitor.app/embed.html'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/embed.html');
  });

  test('falls through to a rewrite when the asset is missing', async () => {
    // Not /countries/japan: vercel.json's catch-all rewrite explicitly
    // excludes /countries (see tests/worker/resolve.test.mts, "/countries is
    // excluded from the SPA catch-all"), so matchRewrite returns null there
    // and a missing asset stays a 404 — that is correct routing, not a bug.
    // Use a path the catch-all actually covers instead.
    const env = envWith(['/dashboard.html']);
    const res = await worker.fetch(get('https://www.worldmonitor.app/some-nonexistent-page'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/dashboard.html');
  });

  test('serves the variant dashboard for a variant host', async () => {
    const env = envWith(['/dashboard-tech.html']);
    const res = await worker.fetch(get('https://tech.worldmonitor.app/dashboard'), env);
    expect(await res.text()).toBe('asset:/dashboard-tech.html');
  });

  test('serves the pro welcome page at / because no asset lives there', async () => {
    const env = envWith(['/pro/welcome.html', '/dashboard.html']);
    const res = await worker.fetch(get('https://www.worldmonitor.app/'), env);
    expect(await res.text()).toBe('asset:/pro/welcome.html');
  });

  test('serves the agent view for /?mode=agent', async () => {
    const env = envWith(['/agent-view.json', '/pro/welcome.html']);
    const res = await worker.fetch(get('https://www.worldmonitor.app/?mode=agent'), env);
    expect(await res.text()).toBe('asset:/agent-view.json');
  });

  test('applies the header table to an asset response', async () => {
    const env = envWith(['/dashboard.html']);
    const res = await worker.fetch(get('https://www.worldmonitor.app/dashboard'), env);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBeTruthy();
  });

  test('returns 404 when neither an asset nor a rewrite matches', async () => {
    const env = envWith([]);
    const res = await worker.fetch(get('https://www.worldmonitor.app/assets/gone.js'), env);
    expect(res.status).toBe(404);
  });

  // These use /docs/mcp as the sample proxied path. /mcp stood here first and
  // /a2a second; both now answer in the Worker (worker/routes/mcp.ts,
  // worker/routes/agent.ts) and never reach the proxy. /docs/mcp is the last
  // rewrite the table still sends to UPSTREAM_API_ORIGIN -- it fronts upstream's
  // Mintlify docs MCP, which we build ourselves and do not plan to port. If it
  // ever goes, these tests need a stubbed rewrite table instead of a real path.
  test('proxies an api rewrite to the upstream origin', async () => {
    const seen: string[] = [];
    const env = envWith([]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string) => {
      seen.push(typeof input === 'string' ? input : input.url);
      return new Response('upstream', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await worker.fetch(get('https://www.worldmonitor.app/docs/mcp'), env);
      expect(await res.text()).toBe('upstream');
      expect(seen[0]).toBe('https://vercel-origin.worldmonitor.app/api/docs-mcp');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Regression test for the Critical review finding: env.ASSETS.fetch(request)
  // used to run unconditionally, before the rewrite check, disturbing the
  // request body's stream. When the rewrite then matched an /api/* proxy, the
  // proxy()'s `new Request(target, request)` tried to read that same
  // already-locked body and threw. Every JSON-RPC/OAuth POST endpoint the
  // rewrite table exists for (`/a2a`, `/ask`, `/oauth/token`, ...) hit
  // this. A GET-only test cannot catch it, because GET requests never carry a
  // body to disturb in the first place.
  test('proxies a POST rewrite without disturbing the request body', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const env = envWith([]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request) => {
      seen.push({ url: input.url, body: await input.text() });
      return new Response('upstream', { status: 200 });
    }) as typeof fetch;
    try {
      const req = new Request('https://www.worldmonitor.app/docs/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('upstream');
      expect(seen[0]?.url).toBe('https://vercel-origin.worldmonitor.app/api/docs-mcp');
      expect(seen[0]?.body).toBe(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('forwards the original host to the upstream origin', async () => {
    let forwarded: string | null = null;
    const env = envWith([]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request) => {
      forwarded = input.headers.get('X-Forwarded-Host');
      return new Response('upstream', { status: 200 });
    }) as typeof fetch;
    try {
      // Not a *.worldmonitor.app subdomain: /docs/* on those 308s to www
      // before it ever reaches the proxy.
      await worker.fetch(get('https://worldmonitor.sibt.ai/docs/mcp'), env);
      expect(forwarded).toBe('worldmonitor.sibt.ai');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('preserves the query string on a redirect', async () => {
    const env = envWith([]);
    const res = await worker.fetch(
      get('https://www.worldmonitor.app/security.txt?ref=abc'),
      env,
    );
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/.well-known/security.txt?ref=abc');
  });

  test('preserves the query string when proxying an api rewrite', async () => {
    const seen: string[] = [];
    const env = envWith([]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string) => {
      seen.push(typeof input === 'string' ? input : input.url);
      return new Response('upstream', { status: 200 });
    }) as typeof fetch;
    try {
      await worker.fetch(get('https://www.worldmonitor.app/docs/mcp?foo=bar'), env);
      expect(seen[0]).toBe('https://vercel-origin.worldmonitor.app/api/docs-mcp?foo=bar');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Locks in the corrected invariant comment in worker/index.ts: the
  // asset-relative branch of resolveDestination is reachable a SECOND time
  // for the same GET request (once as the direct probe, once via the SPA
  // catch-all rewrite after a 404) — safe only because GET/HEAD never carry
  // a body, so there's nothing to lock or re-read either time.
  test('calls ASSETS.fetch twice for a GET that 404s then falls through to the SPA rewrite', async () => {
    let calls = 0;
    const env: Env = {
      ASSETS: {
        async fetch(request: Request) {
          calls += 1;
          const { pathname } = new URL(request.url);
          return pathname === '/dashboard.html'
            ? new Response('asset:/dashboard.html', { status: 200 })
            : new Response('not found', { status: 404 });
        },
      },
      UPSTREAM_API_ORIGIN: 'https://vercel-origin.worldmonitor.app',
    };
    const res = await worker.fetch(
      get('https://www.worldmonitor.app/some-nonexistent-page'),
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  // Regression tests for the html_handling: "none" gap found by the parity
  // harness (scripts/routing-parity.mjs): vercel.json sets neither cleanUrls
  // nor trailingSlash, so Vercel's static host falls back to serving a
  // directory's index.html and redirecting bare paths to add the trailing
  // slash. "none" turns both off, so a real page like
  // dist/countries/afghanistan/index.html 404s. /countries is excluded from
  // the SPA catch-all (resolve.test.mts), so nothing downstream can catch
  // this miss either -- it has to be handled at the asset-probe step itself.
  test('redirects a directory path to its trailing slash when an index.html exists', async () => {
    const env = envWith(['/countries/afghanistan/index.html']);
    const res = await worker.fetch(
      get('https://www.worldmonitor.app/countries/afghanistan'),
      env,
    );
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/countries/afghanistan/');
  });

  test('serves the directory index directly when the trailing slash is already present', async () => {
    const env = envWith(['/countries/afghanistan/index.html']);
    const res = await worker.fetch(
      get('https://www.worldmonitor.app/countries/afghanistan/'),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/countries/afghanistan/index.html');
  });

  test('preserves the query string on a directory-index redirect', async () => {
    const env = envWith(['/countries/afghanistan/index.html']);
    const res = await worker.fetch(
      get('https://www.worldmonitor.app/countries/afghanistan?ref=x'),
      env,
    );
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe('/countries/afghanistan/?ref=x');
  });

  test('applies the header table to a served directory index but not to its redirect', async () => {
    const env = envWith(['/countries/afghanistan/index.html']);
    const redirectRes = await worker.fetch(
      get('https://www.worldmonitor.app/countries/afghanistan'),
      env,
    );
    expect(redirectRes.headers.get('X-Content-Type-Options')).toBeNull();

    const contentRes = await worker.fetch(
      get('https://www.worldmonitor.app/countries/afghanistan/'),
      env,
    );
    expect(contentRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  // Uses /reference/, not /countries/: upstream's merge added five explicit
  // slug redirects to vercel.json (/countries/:slug([a-z0-9-]+) and the same
  // rule for chokepoints, research, crises, tools), so a bare /countries/x
  // now 308s from the redirect table before the asset probe ever runs —
  // which is what production Vercel does too. /reference/ is excluded from
  // the SPA catch-all and carries no slug rule, so it still reaches the
  // implicit directory-index default this test is about.
  test('stays a 404 when a directory genuinely has no index.html', async () => {
    const env = envWith([]);
    const res = await worker.fetch(
      get('https://www.worldmonitor.app/reference/nowhereland'),
      env,
    );
    expect(res.status).toBe(404);
  });

  // Deleting the pathname.endsWith('/index.html') guard in
  // resolveDirectoryIndex (worker/index.ts) still 404s here -- the stub
  // 404s on every unlisted path either way -- so a status-only assertion
  // doesn't actually pin the guard. What the guard prevents is a second,
  // double-suffixed probe (".../index.html/index.html"); asserting the call
  // count and the exact probed URL is what catches its removal.
  test('does not loop when the literal index.html path itself is missing', async () => {
    const probed: string[] = [];
    const env: Env = {
      ASSETS: {
        async fetch(request: Request) {
          probed.push(new URL(request.url).pathname);
          return new Response('not found', { status: 404 });
        },
      },
      UPSTREAM_API_ORIGIN: 'https://vercel-origin.worldmonitor.app',
    };
    const res = await worker.fetch(
      get('https://www.worldmonitor.app/reference/changelog/index.html'),
      env,
    );
    expect(res.status).toBe(404);
    expect(probed).toEqual(['/reference/changelog/index.html']);
  });

  // Regression for a real bug the parity harness caught in the first attempt
  // at this fix: dist/pro/index.html exists AND vercel.json has an explicit
  // rewrite for it (source "/pro" -> destination "/pro/index.html"), so
  // production serves it at 200 with no redirect. An early version of
  // resolveDirectoryIndex ran before matchRewrite and 308-redirected /pro to
  // /pro/ instead -- a real divergence from Vercel, not a fix. The explicit
  // rewrite must always be checked, and win, before the implicit default.
  test('serves an explicit rewrite destination directly instead of the implicit directory-index redirect', async () => {
    const env = envWith(['/pro/index.html']);
    const res = await worker.fetch(get('https://www.worldmonitor.app/pro'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/pro/index.html');
  });

  test('returns 502 instead of throwing when the upstream proxy fetch fails', async () => {
    const env = envWith([]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    try {
      const res = await worker.fetch(get('https://www.worldmonitor.app/docs/mcp'), env);
      expect(res.status).toBe(502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * No rewrite in the shipped config points off-origin any more. The last one
 * did, to Mintlify, until we started building the docs ourselves. The worker's
 * absolute-destination branch stays, because the config format still accepts an
 * absolute URL and without the branch one would be read as a path and 404
 * against the assets. So this drives it through a stubbed table rather than the
 * live one.
 */
describe('an absolute rewrite destination', () => {
  test('proxies to that origin, query string and all', async () => {
    vi.resetModules();
    vi.doMock('../../worker/routing/resolve', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../worker/routing/resolve')>();
      return {
        ...actual,
        matchRewrite: (parts: RequestParts) =>
          parts.pathname === '/offsite'
            ? {
                destination: mergeQueryString(
                  'https://origin.example/offsite',
                  parts.search,
                ),
              }
            : actual.matchRewrite(parts),
      };
    });

    const { default: patched } = await import('../../worker/index');
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string) => {
      seen.push(typeof input === 'string' ? input : input.url);
      return new Response('offsite', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await patched.fetch(
        get('https://www.worldmonitor.app/offsite?utm_source=x'),
        envWith([]),
      );
      expect(seen[0]).toBe('https://origin.example/offsite?utm_source=x');
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
      vi.doUnmock('../../worker/routing/resolve');
      vi.resetModules();
    }
  });
});
