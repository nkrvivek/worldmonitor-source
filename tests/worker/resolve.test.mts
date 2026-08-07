import { describe, expect, test } from 'vitest';
import { headersFor, hostMatches, matchRedirect, matchRewrite } from '../../worker/routing/resolve';
import { compileHeaderRules, compileRules } from '../../worker/routing/table';

const parts = (host: string, pathname: string, query = '') => ({
  host,
  pathname,
  search: new URLSearchParams(query),
});

describe('matchRedirect', () => {
  test('permanent: true becomes 308', () => {
    const hit = matchRedirect(parts('www.worldmonitor.app', '/security.txt'));
    expect(hit).toEqual({ location: '/.well-known/security.txt', status: 308 });
  });

  test('permanent: false becomes 307', () => {
    const hit = matchRedirect(parts('www.worldmonitor.app', '/privacy'));
    expect(hit).toEqual({ location: '/docs/privacy', status: 307 });
  });

  test('host-scoped /docs redirect fires on a variant host', () => {
    const hit = matchRedirect(parts('tech.worldmonitor.app', '/docs/quickstart'));
    expect(hit?.location).toBe('https://www.worldmonitor.app/docs/quickstart');
    expect(hit?.status).toBe(308);
  });

  test('host-scoped /docs redirect fires on bare /docs of a variant host', () => {
    const hit = matchRedirect(parts('finance.worldmonitor.app', '/docs'));
    expect(hit?.location).toBe('https://www.worldmonitor.app/docs/');
  });

  test('/docs on www falls to the non-host rule, not the variant redirect', () => {
    const hit = matchRedirect(parts('www.worldmonitor.app', '/docs'));
    expect(hit).toEqual({ location: '/docs/documentation/', status: 307 });
  });

  test('returns null when nothing matches', () => {
    expect(matchRedirect(parts('www.worldmonitor.app', '/dashboard'))).toBeNull();
  });

  test('carries the incoming query string through to the Location', () => {
    const hit = matchRedirect(parts('www.worldmonitor.app', '/security.txt', 'ref=abc'));
    expect(hit?.location).toBe('/.well-known/security.txt?ref=abc');
  });

  test('carries the incoming query string through an off-origin redirect', () => {
    const hit = matchRedirect(
      parts('tech.worldmonitor.app', '/docs/quickstart', 'utm_source=x'),
    );
    expect(hit?.location).toBe('https://www.worldmonitor.app/docs/quickstart?utm_source=x');
  });
});

describe('matchRewrite', () => {
  test('?mode=agent on / wins over the host rule', () => {
    // The query string is passed through to the destination even though it
    // was also the has:query condition that selected this rule — matching a
    // has condition does not consume the param unless it's a named capture
    // substituted into the destination (which this isn't).
    const hit = matchRewrite(parts('www.worldmonitor.app', '/', 'mode=agent'));
    expect(hit).toEqual({ destination: '/agent-view.json?mode=agent' });
  });

  test('/ without the query falls to the host rule', () => {
    const hit = matchRewrite(parts('www.worldmonitor.app', '/'));
    expect(hit).toEqual({ destination: '/pro/welcome.html' });
  });

  test('/ on the apex host also matches the host rule', () => {
    expect(matchRewrite(parts('worldmonitor.app', '/'))?.destination).toBe(
      '/pro/welcome.html',
    );
  });

  // vercel.json's catch-all rewrite (rewrites[26]) carries no `has` condition,
  // so it applies to "/" regardless of host — an unrelated host still falls
  // through to the SPA shell, it does not go unmatched.
  test('/ on an unrelated host falls to the unconditional catch-all', () => {
    expect(matchRewrite(parts('preview.example.com', '/'))).toEqual({
      destination: '/dashboard.html',
    });
  });

  test('each variant host gets its own dashboard', () => {
    for (const variant of ['tech', 'finance', 'commodity', 'happy', 'energy']) {
      const hit = matchRewrite(parts(`${variant}.worldmonitor.app`, '/dashboard'));
      expect(hit).toEqual({ destination: `/dashboard-${variant}.html` });
    }
  });

  test('/dashboard on www falls to the unconditional rule', () => {
    expect(matchRewrite(parts('www.worldmonitor.app', '/dashboard'))).toEqual({
      destination: '/dashboard.html',
    });
  });

  test('bare paths rewrite onto same-origin api handlers', () => {
    const cases: Array<[string, string]> = [
      ['/mcp', '/api/mcp'],
      ['/a2a', '/api/a2a'],
      ['/ask', '/api/ask'],
      ['/agent/auth', '/api/agent-auth'],
      ['/oauth/token', '/api/oauth/token'],
      ['/.well-known/mcp', '/api/mcp'],
      ['/.well-known/oauth-protected-resource', '/api/oauth-protected-resource'],
    ];
    for (const [from, to] of cases) {
      expect(matchRewrite(parts('www.worldmonitor.app', from))).toEqual({
        destination: to,
      });
    }
  });

  // We build the docs ourselves now (docs-site/), so /docs pages are assets
  // like any other. The one /docs rewrite left is /docs/mcp, and the SPA
  // catch-all excludes docs, so everything else must fall through to ASSETS.
  test('a docs page matches no rewrite and falls through to the assets', () => {
    expect(matchRewrite(parts('www.worldmonitor.app', '/docs/x'))).toBeNull();
    expect(matchRewrite(parts('www.worldmonitor.app', '/docs/mcp'))).toEqual({
      destination: '/api/docs-mcp',
    });
  });

  // /countries is one of the literal alternatives in the catch-all's negative
  // lookahead (rewrites[26] excludes api, docs, countries, chokepoints, ...),
  // so it is deliberately NOT covered by the SPA fallback — pick a path outside
  // that exclusion list to exercise the catch-all itself.
  test('an unknown path falls to the SPA catch-all', () => {
    expect(matchRewrite(parts('www.worldmonitor.app', '/nonexistent-page'))).toEqual({
      destination: '/dashboard.html',
    });
  });

  test('/countries is excluded from the SPA catch-all', () => {
    expect(matchRewrite(parts('www.worldmonitor.app', '/countries/japan'))).toBeNull();
  });

  test('the catch-all excludes asset prefixes', () => {
    for (const path of ['/assets/main.js', '/favico/x.png', '/data/f.json', '/sw.js']) {
      expect(matchRewrite(parts('www.worldmonitor.app', path))).toBeNull();
    }
  });
});

describe('headersFor', () => {
  test('applies the catch-all security block', () => {
    const h = headersFor('/dashboard.html');
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.get('Content-Security-Policy')).toBeTruthy();
  });

  test('a later block overrides an earlier one on the same key', () => {
    const catchAll = headersFor('/countries/japan').get('Cache-Control');
    const assets = headersFor('/assets/main-abc123.js').get('Cache-Control');
    expect(assets).not.toBe(catchAll);
    expect(assets).toContain('immutable');
  });

  test('/docs gets its own block and not the catch-all CSP', () => {
    const h = headersFor('/docs/quickstart');
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.get('Content-Security-Policy')).toBeNull();
  });

  test('embed is excluded from the catch-all block', () => {
    expect(headersFor('/embed.html').get('X-Frame-Options')).toBeNull();
  });

  test('api paths carry the RateLimit advertisement headers', () => {
    const h = headersFor('/api/bootstrap');
    expect(h.get('RateLimit-Policy')).toBeTruthy();
    expect(h.get('RateLimit-Limit')).toBeTruthy();
  });
});

describe('hostMatches', () => {
  test('treats a fully anchored value as a regex', () => {
    expect(hostMatches('^(?:tech|finance)\\.worldmonitor\\.app$', 'tech.worldmonitor.app')).toBe(
      true,
    );
    expect(hostMatches('^(?:tech|finance)\\.worldmonitor\\.app$', 'evil.worldmonitor.app')).toBe(
      false,
    );
  });

  test('treats a value with neither anchor as a literal', () => {
    expect(hostMatches('finance.worldmonitor.app', 'finance.worldmonitor.app')).toBe(true);
    expect(hostMatches('finance.worldmonitor.app', 'xfinance.worldmonitor.app')).toBe(false);
  });

  // A value anchored on only one end is neither of the two documented shapes
  // ("fully anchored regex" or "literal") — it must NOT be treated as a
  // regex, because `endsWith('$') || startsWith('^')` alone would let a
  // trailing bare "$" turn an otherwise-literal value into an unanchored-at-
  // the-front regex, e.g. "tech.worldmonitor.app$" would then match
  // "evil-tech.worldmonitor.app" (regex "$" only anchors the end). Treating
  // it as a literal instead means it can only ever equal itself exactly.
  test('treats a value anchored on only one end as a literal, not a regex', () => {
    const value = 'tech.worldmonitor.app$';
    expect(hostMatches(value, 'evil-tech.worldmonitor.app')).toBe(false);
    expect(hostMatches(value, value)).toBe(true);
  });
});

describe('compileRules', () => {
  // vercelConfig is read through an `as RawRule[]` cast with no runtime
  // check, so a typo'd has.type in a future vercel.json edit would otherwise
  // compile silently and only ever fail its condition at match time. This
  // must throw when the table compiles, not wait for a matching request.
  test('throws on an unrecognized has.type, naming the offending value', () => {
    expect(() =>
      compileRules([
        {
          source: '/example',
          destination: '/example-dest',
          has: [{ type: 'cookie' as never, value: 'x' }],
        },
      ]),
    ).toThrow('cookie');
  });
});

describe('compileHeaderRules', () => {
  // headersFor() (resolve.ts) never reads a `has` field and
  // CompiledHeaderRule has none, so a header rule declaring `has` would
  // otherwise compile silently and its condition would simply never be
  // evaluated — the exact failure assertKnownHasTypes exists to prevent for
  // redirects/rewrites, reopened here because compileRules's guard never
  // runs over header rules. Vercel's schema does allow `has` on header
  // blocks, so this must fail loudly at load time rather than waiting for
  // someone to notice their condition never fires.
  test('throws when a header rule declares a has condition, naming the source', () => {
    expect(() =>
      compileHeaderRules([
        {
          source: '/example',
          headers: [{ key: 'X-Test', value: '1' }],
          has: [{ type: 'host', value: 'worldmonitor.app' }],
        },
      ]),
    ).toThrow('/example');
  });

  test('compiles a header rule with no has condition', () => {
    const [rule] = compileHeaderRules([
      { source: '/example', headers: [{ key: 'X-Test', value: '1' }] },
    ]);
    expect(rule?.headers).toEqual([{ key: 'X-Test', value: '1' }]);
  });
});
