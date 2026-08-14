import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { managedSeedServices } from '../scripts/seed-services-registry.mjs';
import {
  extractBundleMembers,
  stripComments,
  walkContainerGraph,
} from './_lib/import-graph-walk.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NIXPACKS_BUILD_FILES = Object.freeze([
  'scripts/package.json',
  'scripts/package-lock.json',
  'scripts/nixpacks.toml',
]);

// walkContainerGraph only follows import/require/dynamic-import edges, so a data
// file pulled in with fs is invisible to it -- and one already is:
// scripts/seed-supply-chain-trade.mjs reads scripts/shared/un-to-iso2.json via
// readFileSync(join(__dirname, ...)). Without this extractor the closure guard
// cannot tell whether such a path is watched, which is exactly the
// silently-skipped-deployment class the registry exists to prevent.
function extractFileReadDependencies(files, repoRootDir) {
  const dependencies = new Set();
  const add = (fromFile, ...segments) => {
    const resolved = resolve(dirname(fromFile), ...segments);
    if (!resolved.startsWith(repoRootDir)) return;
    if (!existsSync(resolved)) return;
    dependencies.add(relative(repoRootDir, resolved));
  };
  for (const file of files) {
    if (!/\.[cm]?[jt]s$/u.test(file)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    // readFileSync(join(__dirname, 'shared', 'x.json')) -- any local alias of
    // readFileSync/join (the seeders import them as _readFileSync/_join).
    for (const match of source.matchAll(
      /\b_?readFileSync\s*\(\s*_?join\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,\s*)*['"][^'"]+['"])\s*\)/gu,
    )) {
      const segments = [...match[1].matchAll(/['"]([^'"]+)['"]/gu)].map((m) => m[1]);
      if (segments.length > 0) add(file, ...segments);
    }
    // readFileSync(new URL('./x.json', import.meta.url))
    for (const match of source.matchAll(
      /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
    )) {
      add(file, match[1]);
    }
  }
  return dependencies;
}

function extractSharedConfigDependencies(files, deployMode) {
  const prefix = deployMode === 'nixpacks-root-scripts'
    ? 'scripts/shared'
    : 'shared';
  const dependencies = new Set();
  for (const file of files) {
    if (!/\.[cm]?[jt]s$/u.test(file)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/\bloadSharedConfig\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      dependencies.add(`${prefix}/${match[1]}`);
    }
  }
  return dependencies;
}

const exampleEntry = {
  entry: 'scripts/seed-example.mjs',
  service: 'seed-example',
  watchPatterns: [
    'scripts/seed-example.mjs',
    'scripts/_seed-utils.mjs',
    'scripts/package.json',
    'scripts/package-lock.json',
    'scripts/nixpacks.toml',
  ],
  cronSchedule: '*/15 * * * *',
};

describe('registry shape validation', () => {
  it('rejects an unknown deployMode instead of skipping the rootDirectory check', () => {
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, deployMode: 'nixpacks-root-scrpits' }]),
      /unknown deployMode "nixpacks-root-scrpits"/,
    );
  });

  it('rejects an unknown lifecycle instead of silently including it', () => {
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, lifecycle: 'planed' }]),
      /unknown lifecycle "planed"; expected active or planned/,
    );
  });

  it('rejects a non-array watchPatterns instead of comparing it clean', () => {
    // A non-array used to collapse to [], which compares equal to a whole-repo
    // filter — and the closure contract test skips the same entry on
    // `Array.isArray`, so this shape escaped BOTH gates.
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, watchPatterns: 'scripts/seed-example.mjs' }]),
      /watchPatterns must be an array of strings/,
    );
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, watchPatterns: ['scripts/a.mjs', 42] }]),
      /watchPatterns must be an array of strings/,
    );
  });

  it('rejects a malformed cronSchedule or requiredEnv declaration', () => {
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, cronSchedule: 15 }]),
      /cronSchedule must be a string or null/,
    );
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, requiredEnv: [[]] }]),
      /empty any-of group/,
    );
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, requiredEnv: ['lower_case'] }]),
      /invalid requiredEnv name/,
    );
  });

  it('rejects malformed Dockerfile declarations', () => {
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, deployMode: 'dockerfile' }]),
      /deployMode dockerfile requires a dockerfile path/,
    );
    assert.throws(
      () => managedSeedServices([{ ...exampleEntry, dockerfile: 42 }]),
      /dockerfile must be a non-empty string/,
    );
  });

  it('rejects a registry that is not an array', () => {
    assert.throws(() => managedSeedServices({}), /must be an array/);
  });
});

describe('planned seed service lifecycle', () => {
  // A registry row for a service we have decided to run but have not stood up
  // yet. The fixture is deliberately not a live row: the point is the
  // lifecycle field, not any one service.
  const planned = {
    service: 'planned-retention',
    deployMode: 'dockerfile',
    dockerfile: 'Dockerfile.planned-retention',
    lifecycle: 'planned',
    requiredEnv: ['PGHOST'],
    watchPatterns: ['scripts/planned-retention.sql', 'Dockerfile.planned-retention'],
    cronSchedule: '7,22,37,52 * * * *',
  };

  it('leaves an intentionally absent planned service out', () => {
    assert.deepEqual(managedSeedServices([planned]), []);
  });

  it('includes the service after an explicit activation transition', () => {
    const active = { ...planned, lifecycle: 'active' };
    assert.deepEqual(managedSeedServices([active]), [active]);
  });

  it('still validates a planned row, so its shape is checked before it runs', () => {
    assert.throws(
      () => managedSeedServices([{ ...planned, cronSchedule: 15 }]),
      /cronSchedule must be a string or null/,
    );
  });
});

describe('critical ingestion seed registry contract', () => {
  const registry = JSON.parse(
    readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
  );
  // Cron pins stay an explicit literal: these are production schedules and a
  // silent edit to one should fail loudly rather than be rubber-stamped by
  // reading the same file the change lives in.
  const expected = new Map([
    ['seed-conflict-intel', '*/15 * * * *'],
    ['seed-gdelt-intel', '*/15 * * * *'],
    ['seed-supply-chain-trade', '0 */6 * * *'],
    ['seed-comtrade-bilateral-hs4', '0 6 1 * *'],
    ['seed-bundle-market-backup', '*/5 * * * *'],
    ['seed-bundle-derived-signals', '*/5 * * * *'],
    ['seed-bundle-portwatch', '0 */1 * * *'],
    ['seed-bundle-portwatch-port-activity', '0 */12 * * *'],
  ]);

  // Closure coverage is DERIVED from the same predicate every caller uses to
  // decide which rows carry a dependency closure. A hardcoded list here would
  // let a future registry entry ship narrow watch paths with its dependency
  // closure never verified.
  const closureManaged = managedSeedServices(registry)
    .filter((entry) => Array.isArray(entry.watchPatterns) && entry.watchPatterns.length > 0);

  it('keeps an always-on service on whole-repository rebuilds', () => {
    const publisher = registry.find((entry) => entry.service === 'publish-bootstrap-tiers');
    assert.ok(publisher, 'publish-bootstrap-tiers must be registered');
    assert.deepEqual(
      publisher.watchPatterns,
      [],
      'empty watch paths intentionally rebuild the service for any repository change',
    );
    assert.ok(
      managedSeedServices(registry).includes(publisher),
      'an always-on service must stay in the managed set',
    );
  });

  it('every cron pin names a service the registry manages', () => {
    const managedNames = new Set(closureManaged.map((entry) => entry.service));
    for (const serviceName of expected.keys()) {
      assert.ok(managedNames.has(serviceName), `${serviceName} must be registry-managed`);
    }
  });

  it('covers every managed service with watch paths', () => {
    assert.ok(closureManaged.length >= expected.size);
  });

  for (const entry of closureManaged) {
    const serviceName = entry.service;
    it(`${serviceName} pins its cron and complete runtime dependency closure`, () => {
      if (expected.has(serviceName)) {
        assert.equal(entry.cronSchedule, expected.get(serviceName));
      }
      assert.ok(Array.isArray(entry.watchPatterns), `${serviceName} must declare watchPatterns`);
      assert.ok(entry.watchPatterns.length > 0, `${serviceName} watchPatterns must not be empty`);
      assert.equal(
        new Set(entry.watchPatterns).size,
        entry.watchPatterns.length,
        `${serviceName} watchPatterns must not contain duplicates`,
      );
      assert.ok(!entry.watchPatterns.includes('scripts/**'), `${serviceName} must not watch every seeder`);
      assert.ok(!entry.watchPatterns.includes('shared/**'), `${serviceName} must not watch all shared data`);
      for (const watchedPath of entry.watchPatterns) {
        assert.ok(!watchedPath.includes('*'), `${serviceName} must use exact watch paths`);
        assert.ok(
          existsSync(resolve(repoRoot, watchedPath)),
          `${serviceName} watchPatterns references missing ${watchedPath}`,
        );
      }

      const entryPath = resolve(repoRoot, entry.entry);
      const source = readFileSync(entryPath, 'utf8');
      const roots = [
        entryPath,
        ...extractBundleMembers(source).map((member) => resolve(repoRoot, 'scripts', member)),
      ];
      const scriptsDir = resolve(repoRoot, 'scripts');
      const { visited, unresolved } = walkContainerGraph(roots, {
        repoRoot,
        copyRootDirs: [scriptsDir, repoRoot],
        dynamicRootDirs: [scriptsDir],
        installedPackages: new Set(),
        hasTsx: false,
      });
      assert.deepEqual(unresolved, [], `${serviceName} runtime graph must resolve`);

      const watched = new Set(entry.watchPatterns);
      const runtimeFiles = new Set([
        ...[...visited].map((file) => relative(repoRoot, file)),
        ...extractSharedConfigDependencies(visited, entry.deployMode),
        ...extractFileReadDependencies(visited, repoRoot),
      ]);
      const missingRuntimeFiles = [...runtimeFiles]
        .filter((file) => !watched.has(file))
        .sort();
      assert.deepEqual(
        missingRuntimeFiles,
        [],
        `${serviceName} watchPatterns omit runtime dependencies`,
      );

      // The reverse direction. Without it a watch path that drops out of the
      // import graph lingers forever in a hand-typed 44-entry array, rebuilding
      // the service on changes it no longer depends on -- the exact cost the
      // exact-path registry was introduced to eliminate.
      const staleWatchedFiles = [...watched]
        .filter((file) => !runtimeFiles.has(file)
          && file !== entry.dockerfile
          && !NIXPACKS_BUILD_FILES.includes(file))
        .sort();
      assert.deepEqual(
        staleWatchedFiles,
        [],
        `${serviceName} watchPatterns contain paths that are no longer runtime dependencies`,
      );

      if (entry.deployMode === 'nixpacks-root-scripts') {
        for (const buildFile of NIXPACKS_BUILD_FILES) {
          assert.ok(watched.has(buildFile), `${serviceName} must watch ${buildFile}`);
        }
      }
      if (entry.dockerfile) {
        assert.ok(watched.has(entry.dockerfile), `${serviceName} must watch its Dockerfile`);
      }
    });
  }
});
