// The warm-ping path list lives in three places: the gateway allowlist
// (server/gateway.ts RELAY_WARM_PING_PATHS — the authority, since it decides
// which paths the relay key opens), the container seed (scripts/
// seed-warm-ping.mjs — the reliable cadence), and warm-ping.yml (the GitHub
// backup). A path present in one and missing in another either warms nothing
// (401s at the gateway) or leaves a cache cold on one rail. This pins all
// three together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function gatewayPaths() {
  const src = read('server/gateway.ts');
  const block = src.match(/RELAY_WARM_PING_PATHS = new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'server/gateway.ts must declare RELAY_WARM_PING_PATHS');
  // Strip comments first: an apostrophe in prose ("the seeder's warm call")
  // otherwise reads as a string delimiter.
  const code = block[1].replace(/\/\/[^\n]*/g, '');
  return new Set([...code.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function seedPaths() {
  const src = read('scripts/seed-warm-ping.mjs');
  const block = src.match(/const WARM_TARGETS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'scripts/seed-warm-ping.mjs must declare WARM_TARGETS');
  // Strip query strings: the gateway allowlists pathnames only.
  return new Set(
    [...block[1].matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1].split('?')[0]),
  );
}

function workflowPaths() {
  const src = read('.github/workflows/warm-ping.yml');
  return new Set(
    [...src.matchAll(/"\$API_BASE_URL(\/api\/[^"]+)"/g)].map((m) =>
      m[1].split('?')[0],
    ),
  );
}

test('the container warm seed mirrors the gateway allowlist exactly', () => {
  assert.deepEqual([...seedPaths()].sort(), [...gatewayPaths()].sort());
});

test('the GitHub backup workflow mirrors the gateway allowlist exactly', () => {
  assert.deepEqual([...workflowPaths()].sort(), [...gatewayPaths()].sort());
});
