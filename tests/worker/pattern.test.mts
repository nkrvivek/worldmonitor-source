import { describe, expect, test } from 'vitest';
import { applyDestination, compileSource, mergeQueryString } from '../../worker/routing/pattern';

describe('compileSource', () => {
  test('matches a literal source exactly', () => {
    const { regex } = compileSource('/security.txt');
    expect(regex.test('/security.txt')).toBe(true);
    expect(regex.test('/security.txt/extra')).toBe(false);
    expect(regex.test('/asecurity.txt')).toBe(false);
  });

  test('escapes regex metacharacters in literals', () => {
    const { regex } = compileSource('/embed.html');
    expect(regex.test('/embed.html')).toBe(true);
    expect(regex.test('/embedxhtml')).toBe(false);
  });

  test('captures a single-segment :param', () => {
    const { regex, params } = compileSource('/workbox-:hash.js');
    expect(params).toEqual(['hash']);
    expect('/workbox-a1b2c3.js'.match(regex)?.[1]).toBe('a1b2c3');
    expect(regex.test('/workbox-a1/b2.js')).toBe(false);
  });

  test('captures a multi-segment :param*', () => {
    const { regex, params } = compileSource('/docs/:match*');
    expect(params).toEqual(['match']);
    expect('/docs/a/b/c'.match(regex)?.[1]).toBe('a/b/c');
  });

  test('makes a trailing /:param* segment optional', () => {
    const { regex } = compileSource('/docs/:match*');
    expect(regex.test('/docs')).toBe(true);
    expect('/docs'.match(regex)?.[1]).toBeUndefined();
  });

  test('passes a raw regex group through verbatim', () => {
    const { regex, params } = compileSource('/((?!api|assets).*)');
    expect(params).toEqual([]);
    expect(regex.test('/countries/japan')).toBe(true);
    expect(regex.test('/api/bootstrap')).toBe(false);
    expect(regex.test('/assets/main.js')).toBe(false);
  });

  test('handles nested parens inside a raw regex group', () => {
    const { regex } = compileSource('/((?!workbox-[a-f0-9]+\\.js).*)');
    expect(regex.test('/workbox-abc123.js')).toBe(false);
    expect(regex.test('/dashboard')).toBe(true);
  });

  test('anchors both ends', () => {
    const { regex } = compileSource('/pro');
    expect(regex.test('/pro')).toBe(true);
    expect(regex.test('/x/pro')).toBe(false);
    expect(regex.test('/pro/index.html')).toBe(false);
  });
});

describe('applyDestination', () => {
  test('substitutes a :param*', () => {
    expect(
      applyDestination(
        'https://www.worldmonitor.app/docs/:match*',
        ['match'],
        ['api-reference/x'],
      ),
    ).toBe('https://www.worldmonitor.app/docs/api-reference/x');
  });

  test('substitutes a bare :param', () => {
    expect(applyDestination('/w-:hash.js', ['hash'], ['abc'])).toBe('/w-abc.js');
  });

  test('treats an unmatched optional param as empty', () => {
    expect(
      applyDestination('https://www.worldmonitor.app/docs/:match*', ['match'], [
        undefined as unknown as string,
      ]),
    ).toBe('https://www.worldmonitor.app/docs/');
  });

  test('leaves a destination with no params untouched', () => {
    expect(applyDestination('/dashboard.html', [], [])).toBe('/dashboard.html');
  });
});

// Vercel passes the incoming request's query string through to the
// destination (Next.js redirects docs: "/old-blog/post-1?hello=world" ->
// "/blog/post-1?hello=world"; Vercel KB redirect-by-query example: a
// destination that already owns "?path=foo" becomes "?path=foo&baz=10" when
// the incoming request carries "?baz=10" — i.e. the destination's own query
// is kept first and the incoming one is appended, not replaced and not
// dropped). Nothing in either doc suggests redirects and rewrites differ
// here, so this rule applies uniformly to both.
describe('mergeQueryString', () => {
  test('leaves the destination untouched when the request has no query', () => {
    expect(mergeQueryString('/dashboard.html', new URLSearchParams(''))).toBe(
      '/dashboard.html',
    );
  });

  test('appends the incoming query when the destination has none of its own', () => {
    expect(mergeQueryString('/dashboard.html', new URLSearchParams('utm_source=x'))).toBe(
      '/dashboard.html?utm_source=x',
    );
  });

  test('appends after the destination template already has its own query', () => {
    expect(mergeQueryString('/home?authorized=yes', new URLSearchParams('utm_source=x'))).toBe(
      '/home?authorized=yes&utm_source=x',
    );
  });

  test('appends onto an absolute-URL destination', () => {
    expect(
      mergeQueryString('https://origin.example/docs/x', new URLSearchParams('ref=1')),
    ).toBe('https://origin.example/docs/x?ref=1');
  });

  test('preserves multiple incoming params in order', () => {
    expect(
      mergeQueryString('/dashboard.html', new URLSearchParams('a=1&b=2')),
    ).toBe('/dashboard.html?a=1&b=2');
  });

  // Pins the append-on-collision branch directly: a destination and the
  // incoming request declaring the SAME key. No live vercel.json rule
  // exercises this today — every real destination is either bare or owns a
  // key the corpus's requests never repeat, so the harness (which needs a
  // live site) cannot settle whether Vercel agrees with this. This test at
  // least keeps our own side deterministic and documented; see the doc
  // comment on mergeQueryString (worker/routing/pattern.ts:112-123) and
  // task-5-report.md ("Fix round 2") for what would verify it against
  // Vercel.
  test('appends rather than replaces when destination and incoming share a key', () => {
    expect(
      mergeQueryString('/home?ref=internal', new URLSearchParams('ref=campaign')),
    ).toBe('/home?ref=internal&ref=campaign');
  });
});
