/**
 * The routing tables, read straight out of vercel.json.
 *
 * vercel.json is the single source of truth for 46 routing rules and 55 header
 * blocks. Hand-transcribing them would be the most likely source of a silent
 * behaviour change, and scripts/routing-parity.mjs needs both sides reading one
 * file.
 *
 * Nothing here runs on Vercel — the name is the point. Upstream keeps editing
 * vercel.json every month, and the whole reason this fork reads it instead of
 * copying it is that an upstream sync then lands new redirects and headers with
 * no merge conflict. Renaming the file would trade a monthly merge for a
 * cosmetic win. An earlier version of this comment said the module gets deleted
 * once the api/ handlers move off Vercel; they have, and it did not — the rules
 * still have to live somewhere.
 */
import vercelConfig from '../../vercel.json';
import { compileSource, type CompiledPattern } from './pattern';

export interface HasCondition {
  type: 'host' | 'query';
  key?: string;
  value: string;
}

export interface CompiledRule {
  pattern: CompiledPattern;
  destination: string;
  permanent?: boolean;
  has?: HasCondition[];
}

export interface CompiledHeaderRule {
  pattern: CompiledPattern;
  headers: Array<{ key: string; value: string }>;
}

interface RawRule {
  source: string;
  destination: string;
  permanent?: boolean;
  has?: HasCondition[];
}

interface RawHeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
  has?: HasCondition[];
}

/**
 * `has` arrives through an `as RawRule[]` cast with no runtime check behind
 * it, so a typo'd or new `has.type` in a future vercel.json edit would
 * otherwise sail through untyped and only surface as a silently-disabled
 * condition at match time (see conditionsMet in resolve.ts). Failing here,
 * when the table compiles, means a bad edit breaks every test and the
 * Worker's module load — not just the one route nobody happens to request.
 */
function assertKnownHasTypes(rule: RawRule): void {
  for (const condition of rule.has ?? []) {
    if (condition.type !== 'host' && condition.type !== 'query') {
      throw new Error(
        `Unrecognized has.type "${condition.type}" on rule "${rule.source}" — expected "host" or "query"`,
      );
    }
  }
}

export function compileRules(raw: RawRule[]): CompiledRule[] {
  return raw.map((rule) => {
    assertKnownHasTypes(rule);
    return {
      pattern: compileSource(rule.source),
      destination: rule.destination,
      permanent: rule.permanent,
      has: rule.has,
    };
  });
}

export const redirects: CompiledRule[] = compileRules(
  (vercelConfig.redirects ?? []) as RawRule[],
);

export const rewrites: CompiledRule[] = compileRules(
  (vercelConfig.rewrites ?? []) as RawRule[],
);

/**
 * `assertKnownHasTypes` above validates that a `has.type` is one of the
 * two types this codebase understands ('host' | 'query') — but that check
 * alone is not enough to close the same hole for header rules. headersFor()
 * (resolve.ts) never reads a `has` field at all, and CompiledHeaderRule has
 * none, so a header rule carrying `has: [{ type: 'host', ... }]` would sail
 * straight through assertKnownHasTypes (host IS a known type) and then be
 * silently dropped when compiling — a condition that looks valid and is
 * simply never evaluated. That is a worse failure than an unknown type,
 * because it never throws anywhere. Vercel's schema does allow `has` on
 * header blocks (worldmonitor's vercel.json just never uses it — 0 of 55
 * blocks do today), so the only safe invariant is: header rules do not
 * support `has` in this implementation, full stop. Fail at load time if one
 * ever declares it, rather than shipping a condition nobody checks.
 */
function assertNoHasCondition(rule: RawHeaderRule): void {
  if (rule.has) {
    throw new Error(
      `Header rule "${rule.source}" declares a "has" condition, but header rules do not evaluate "has" in this implementation (see headersFor in routing/resolve.ts) — remove it, or add has-support to headersFor first.`,
    );
  }
}

export function compileHeaderRules(raw: RawHeaderRule[]): CompiledHeaderRule[] {
  return raw.map((rule) => {
    assertNoHasCondition(rule);
    return {
      pattern: compileSource(rule.source),
      headers: rule.headers,
    };
  });
}

export const headerRules: CompiledHeaderRule[] = compileHeaderRules(
  (vercelConfig.headers ?? []) as RawHeaderRule[],
);
