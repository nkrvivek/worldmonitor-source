import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// Measured on 2026-08-13: `seed-meta:cable-health` held fetchedAt 1786644050279
// (18:00:50Z) while two cache-hit serves at 20:37 and 20:40 had both run the
// line that rewrites it. The write is real, the handler reaches it, and the
// value never moved.
//
// The reason is the shape of the call:
//
//   setCachedJson('seed-meta:cable-health', meta, 604800).catch(() => {});
//
// A floating promise. The handler returns its response, the isolate is free to
// go, and a Redis round-trip that has not resolved yet is simply dropped. It
// never throws, so `.catch` catches nothing and no log is emitted. Freshness
// then ages past the health check's 90-minute bound and the endpoint reports
// stale while serving a map computed minutes ago.
//
// There is no `waitUntil` to reach for: ServerContext is generated code and
// carries only `request`, `pathParams` and `headers`. So the write is awaited.
// That puts one Redis write (5s timeout) on the response path of an endpoint
// cached for 30 minutes, which is a cost paid rarely and bounded when it is.
describe('seed-meta writes', () => {
  const handlerRoot = new URL('../server/worldmonitor/', import.meta.url).pathname;

  const handlers = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  })(handlerRoot);

  // The rule is about what runs, not what the file documents. This comment
  // itself names the floating form on purpose.
  const codeOf = (path: string) =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('are awaited, never left floating', () => {
    const floating: string[] = [];

    for (const path of handlers) {
      const code = codeOf(path);
      const pattern = /(\w+\s+)?setCachedJson\(\s*['"`]seed-meta/g;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(code)) !== null) {
        const keyword = (match[1] || '').trim();
        // `return` is as good as `await` here: the caller of that helper is on
        // the hook for it, and list-temporal-anomalies already awaits its own.
        if (keyword === 'await' || keyword === 'return') continue;
        const line = code.slice(0, match.index).split('\n').length;
        floating.push(`${path.slice(handlerRoot.length)}:${line}`);
      }
    }

    assert.deepEqual(
      floating,
      [],
      `these seed-meta writes can be dropped when the isolate returns: ${floating.join(', ')}`,
    );
  });

  it('found the writes it claims to be guarding', () => {
    // A guard that silently stops matching is worse than no guard. If the call
    // is ever renamed, this fails rather than passing on an empty sweep.
    const total = handlers
      .map(codeOf)
      .reduce((n, code) => n + (code.match(/setCachedJson\(\s*['"`]seed-meta/g) || []).length, 0);

    assert.ok(total >= 5, `expected to find the seed-meta writers, found ${total}`);
  });
});
