#!/usr/bin/env node
// =============================================================================
// Refuses a push whose wrangler.jsonc names a seed image tag this commit does
// not build.
// =============================================================================
// scripts/seed-image-tag.sh derives the tag from the build context, so any edit
// under scripts/, server/, shared/, data/ or worker/counters/ moves it. Nothing
// moves the pin in wrangler.jsonc with it. When the two drift, two CI jobs fail
// on the same commit: "Test" on tests/worker/seed-image-tag.test.mts, and
// "Build seed container image" on its own copy of this comparison. Measured
// twice, on 3d8e3a0f2 and again on 8ce486206.
//
// The vitest test already states this, and states why it cannot be trusted
// before an edit is staged: the tag script reads the git index, so with the
// change unstaged it computes the tag for the previous content, matches the
// pin already written, and passes. Push time is the moment that caveat lifts.
// The index is what gets pushed, so both halves are read from the index here
// and the answer is the one CI will get.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// The one account every worker here deploys to, as in the vitest test.
// Hardcoded rather than read from the environment so this fails on a laptop
// with no CLOUDFLARE_ACCOUNT_ID set rather than skipping.
const ACCOUNT_ID = '3e2617436093fffd3446428537e90efd';

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

const tag = run('./scripts/seed-image-tag.sh', []).trim();
// From the index, not from disk: an unstaged edit to the pin would otherwise
// answer for a file the push does not carry.
const raw = run('git', ['show', ':wrangler.jsonc']);
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
const image = config.containers?.[0]?.image;
const want = `registry.cloudflare.com/${ACCOUNT_ID}/worldmonitor-seeds:${tag}`;

if (image === want) {
  console.log(`  seed image pin matches: ${tag}`);
  process.exit(0);
}

console.error('============================================================');
console.error('ERROR: wrangler.jsonc pins a seed image tag this commit does not build.');
console.error(`  pinned:   ${image}`);
console.error(`  computes: ${want}`);
console.error('');
console.error('Something in the seed build context changed. Re-pin it in this commit:');
console.error('  node -e \'const f="wrangler.jsonc",fs=require("node:fs");' +
  'fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/worldmonitor-seeds:seeds-[0-9a-f]+/,' +
  `"worldmonitor-seeds:${tag}"))'`);
console.error('  git add wrangler.jsonc && git commit --amend --no-edit');
console.error('');
console.error('Pushing as-is fails two CI jobs: "Test" and "Build seed container image".');
console.error('============================================================');
process.exit(1);
