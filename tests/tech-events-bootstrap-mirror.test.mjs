import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// techEvents read EMPTY in prod health for weeks while the panel had data.
// Cause: two keys, one writer. The RPC and the seeder use
// `research:tech-events:v1`, but api/health.js, api/_bootstrap-tier-keys.js and
// shared/bootstrap-tier-keys.js all read the `-bootstrap` mirror, which only the
// retired Railway relay (scripts/ais-relay.cjs seedTechEvents) ever wrote. When
// the relay went away the mirror stopped being written and nothing noticed,
// because the seeder itself was healthy.
//
// Pinned here: the seeder writes BOTH keys, and both share the one seed-meta key
// health reads. Without the explicit override, writeSeedMeta would derive
// `seed-meta:research:tech-events-bootstrap` from the mirror key and leave a
// second meta row nothing reads.

const SEEDER = readFileSync(new URL('../scripts/seed-research.mjs', import.meta.url), 'utf8');
const CANONICAL = "'research:tech-events:v1'";
const MIRROR = "'research:tech-events-bootstrap:v1'";
const META = "'seed-meta:research:tech-events'";

test('the seeder writes the canonical tech-events key', () => {
  assert.ok(SEEDER.includes(`writeExtraKeyWithMeta(${CANONICAL}`), `seed-research.mjs must write ${CANONICAL}`);
});

test('the seeder also writes the bootstrap mirror health actually reads', () => {
  assert.ok(SEEDER.includes(MIRROR), `seed-research.mjs must write ${MIRROR}`);
});

test('the mirror write passes the shared meta key rather than deriving its own', () => {
  const at = SEEDER.indexOf(MIRROR);
  assert.notEqual(at, -1);
  // The override is the 5th argument of the same call, so it sits within the
  // few lines that follow the mirror key.
  const tail = SEEDER.slice(at, at + 400);
  assert.ok(tail.includes(META), `the ${MIRROR} write must pass ${META} as metaKeyOverride`);
  assert.ok(
    !SEEDER.includes('seed-meta:research:tech-events-bootstrap'),
    'no second meta key may be created for the mirror',
  );
});

test('health, the bootstrap tier list and the shared tier list agree on the mirror key', () => {
  const readers = [
    '../api/health.js',
    '../api/_bootstrap-tier-keys.js',
    '../shared/bootstrap-tier-keys.js',
  ];
  for (const rel of readers) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(
      src.includes('research:tech-events-bootstrap:v1'),
      `${rel} must still read the mirror key the seeder writes`,
    );
  }
  const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
  assert.ok(health.includes('seed-meta:research:tech-events'), 'health must read the shared meta key');
});
