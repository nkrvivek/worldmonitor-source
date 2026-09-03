/**
 * Compiles a `vercel.json` route `source` into a RegExp.
 *
 * Three syntaxes appear in worldmonitor's vercel.json:
 *   literal        /security.txt
 *   placeholder    /docs/:match*   /workbox-:hash.js
 *   raw regex      /((?!api|assets).*)
 *
 * A trailing `/:name*` compiles to an OPTIONAL group so `/docs` matches
 * `/docs/:match*` — this is path-to-regexp's behaviour and the host-scoped
 * /docs redirect depends on it.
 */

export interface CompiledPattern {
  regex: RegExp;
  params: string[];
}

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\/]/g;

function escapeLiteral(char: string): string {
  return char.replace(REGEX_METACHARACTERS, '\\$&');
}

/** Returns the index just past the `)` matching the `(` at `start`. */
function findGroupEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`unbalanced ( in route source: ${source}`);
}

export function compileSource(source: string): CompiledPattern {
  const params: string[] = [];
  let pattern = '';
  let i = 0;

  while (i < source.length) {
    const char = source.charAt(i);

    if (char === '(') {
      const end = findGroupEnd(source, i);
      pattern += source.slice(i, end);
      i = end;
      continue;
    }

    if (char === ':') {
      const name = /^[A-Za-z0-9_]+/.exec(source.slice(i + 1))?.[0];
      if (!name) {
        pattern += escapeLiteral(char);
        i += 1;
        continue;
      }
      const afterName = i + 1 + name.length;

      // `:name(regex)` — path-to-regexp lets a param carry its own matcher,
      // and vercel.json uses it on all five slug redirects
      // (/countries/:slug([a-z0-9-]+) and friends). The group IS the param's
      // capture, not a second one after it: falling through to the generic
      // `(` branch below emitted `([^/]+)([a-z0-9-]+)`, whose greedy first
      // group swallowed all but the last character and handed the remainder
      // to a phantom group — so /countries/afghanistan redirected to
      // /countries/afghanista/, dropping the final letter of every slug on
      // all five rules.
      const customStart = source[afterName] === '(' ? afterName : -1;
      const customEnd = customStart === -1 ? -1 : findGroupEnd(source, customStart);
      const custom = customStart === -1 ? null : source.slice(customStart + 1, customEnd - 1);
      const afterPattern = customStart === -1 ? afterName : customEnd;
      const isMulti = source[afterPattern] === '*';
      params.push(name);

      if (custom !== null) {
        // A custom matcher owns its own repetition, so `*` after it only
        // means "this segment may repeat" — `(?:…)*` would drop the capture.
        pattern += isMulti ? `((?:${custom})*)` : `(${custom})`;
      } else if (isMulti && pattern.endsWith('\\/')) {
        // Trailing `/:name*` — the slash belongs to the optional group.
        pattern = `${pattern.slice(0, -2)}(?:\\/(.*))?`;
      } else if (isMulti) {
        pattern += '(.*)';
      } else {
        pattern += '([^/]+)';
      }

      i = afterPattern + (isMulti ? 1 : 0);
      continue;
    }

    pattern += escapeLiteral(char);
    i += 1;
  }

  return { regex: new RegExp(`^${pattern}$`), params };
}

export function applyDestination(
  destination: string,
  params: string[],
  values: string[],
): string {
  let result = destination;
  params.forEach((name, index) => {
    const value = values[index] ?? '';
    result = result.split(`:${name}*`).join(value);
    result = result.split(`:${name}`).join(value);
  });
  return result;
}

/**
 * Vercel passes the incoming request's query string through to whatever the
 * destination resolves to, on both redirects and rewrites — nothing in
 * Vercel's docs distinguishes the two here. When the destination template
 * already owns a query string of its own, the incoming one is appended
 * after it rather than replacing it: Vercel's query-based-redirect example
 * turns a destination "?path=foo" plus an incoming "?baz=10" into
 * "?path=foo&baz=10", not "?baz=10" alone and not "?path=foo" alone.
 *
 * The append-on-collision case below (same key on both sides, e.g. a
 * destination's own "?ref=a" plus an incoming "?ref=b") is pinned by a
 * direct unit test (tests/worker/pattern.test.mts) but unverified against
 * live Vercel: no destination in vercel.json today carries an embedded
 * query string, so the parity harness (scripts/routing-parity.mjs) has
 * nothing to diff this branch against (see task-5-report.md, "Fix round
 * 2"). It would be verified the day a real vercel.json rule adds a
 * destination with its own query and the harness corpus gets a same-key
 * collision entry against that rule.
 */
export function mergeQueryString(destination: string, incoming: URLSearchParams): string {
  if ([...incoming.keys()].length === 0) return destination;

  const queryIndex = destination.indexOf('?');
  const base = queryIndex === -1 ? destination : destination.slice(0, queryIndex);
  const ownQuery = queryIndex === -1 ? '' : destination.slice(queryIndex + 1);

  const merged = new URLSearchParams(ownQuery);
  // Append, never replace, on a shared key — see doc comment above.
  incoming.forEach((value, key) => merged.append(key, value));

  return `${base}?${merged.toString()}`;
}
