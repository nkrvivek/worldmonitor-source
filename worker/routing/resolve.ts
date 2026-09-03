/**
 * Answers the three routing questions over the compiled vercel.json tables.
 *
 * Pure: takes host, pathname and query, returns a decision. No Request, no
 * fetch, no Worker globals — so every routing claim is testable in plain Node.
 */
import { applyDestination, mergeQueryString } from './pattern';
import {
  headerRules,
  redirects,
  rewrites,
  type CompiledRule,
  type HasCondition,
} from './table';

export interface RequestParts {
  host: string;
  pathname: string;
  search: URLSearchParams;
}

/**
 * vercel.json writes host values as either a fully anchored regex (both
 * `^` and `$`) or a plain literal (neither). Requiring BOTH anchors before
 * treating a value as a regex matters: a value anchored on only one end,
 * e.g. "tech.worldmonitor.app$", is not a valid instance of either
 * documented shape, and treating it as a regex anyway would let that bare
 * trailing "$" match any host merely *ending* with the literal text —
 * "evil-tech.worldmonitor.app" included — instead of requiring an exact
 * literal match.
 */
export function hostMatches(value: string, host: string): boolean {
  if (value.startsWith('^') && value.endsWith('$')) {
    return new RegExp(value).test(host);
  }
  return value === host;
}

/**
 * `table.ts`'s `compileRules` already rejects any `has.type` outside
 * `'host' | 'query'` when the table compiles (see assertKnownHasTypes there),
 * so every rule reaching this function is already known-good. The throw
 * below is defense in depth, not the primary guard: if that changes — a
 * caller builds a CompiledRule some other way — this still fails loudly
 * instead of silently disabling the condition.
 */
function conditionsMet(has: HasCondition[] | undefined, parts: RequestParts): boolean {
  if (!has) return true;
  return has.every((condition) => {
    if (condition.type === 'host') return hostMatches(condition.value, parts.host);
    if (condition.type === 'query') {
      return parts.search.get(condition.key ?? '') === condition.value;
    }
    throw new Error(`Unrecognized has.type "${condition.type}"`);
  });
}

function firstMatch(
  rules: CompiledRule[],
  parts: RequestParts,
): { rule: CompiledRule; destination: string } | null {
  for (const rule of rules) {
    const match = rule.pattern.regex.exec(parts.pathname);
    if (!match) continue;
    if (!conditionsMet(rule.has, parts)) continue;
    const destination = applyDestination(
      rule.destination,
      rule.pattern.params,
      match.slice(1),
    );
    return { rule, destination: mergeQueryString(destination, parts.search) };
  }
  return null;
}

export function matchRedirect(
  parts: RequestParts,
): { location: string; status: 307 | 308 } | null {
  const hit = firstMatch(redirects, parts);
  if (!hit) return null;
  return { location: hit.destination, status: hit.rule.permanent ? 308 : 307 };
}

export function matchRewrite(parts: RequestParts): { destination: string } | null {
  const hit = firstMatch(rewrites, parts);
  return hit ? { destination: hit.destination } : null;
}

/**
 * Every matching block applies; on a repeated key the last match wins, which is
 * how /dashboard.html gets its own Cache-Control over the catch-all block's.
 */
export function headersFor(pathname: string): Headers {
  const result = new Headers();
  for (const rule of headerRules) {
    if (!rule.pattern.regex.test(pathname)) continue;
    for (const { key, value } of rule.headers) {
      result.set(key, value);
    }
  }
  return result;
}
