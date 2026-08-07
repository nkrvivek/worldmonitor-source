#!/usr/bin/env node
/**
 * Print the last run record a bundle wrote.
 *
 * Usage: node scripts/show-bundle-run.mjs macro
 *        node scripts/show-bundle-run.mjs            # every bundle with a record
 *
 * The records exist because container stdout does not: nothing can read what a
 * seed printed inside a Cloudflare container, so _bundle-runner.mjs writes each
 * run's per-section outcomes to Redis instead. This is the read side.
 */
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';
import { RUN_RECORD_KEY_PREFIX } from './_bundle-runner.mjs';

loadEnvFile(import.meta.url);
const { url, token } = getRedisCredentials();

// Read the bundle names off disk rather than out of worker/seeds/registry.ts:
// that file is TypeScript, and importing it would make this script need a type
// stripper to run. A bundle the registry no longer schedules simply reports no
// record, which is the same answer either way.
function bundleNames() {
  return readdirSync(dirname(fileURLToPath(import.meta.url)))
    .map((f) => f.match(/^seed-bundle-(.+)\.mjs$/)?.[1])
    .filter(Boolean)
    .sort();
}

async function readRecord(name) {
  const key = `${RUN_RECORD_KEY_PREFIX}${name}`;
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`${key}: HTTP ${resp.status}`);
  const body = await resp.json();
  return body.result ? JSON.parse(body.result) : null;
}

const names = process.argv.slice(2);
for (const name of names.length ? names : bundleNames()) {
  const record = await readRecord(name);
  if (!record) {
    // Absence is a finding, not a blank: either the bundle has not run since
    // the record was added, or its container never reached the end of the loop.
    console.log(`${name}: no run record`);
    continue;
  }
  const age = Math.round((Date.now() - record.fetchedAt) / 60_000);
  console.log(
    `\n${name}: ${age}min ago, ${(record.durationMs / 1000).toFixed(1)}s, ` +
      `ran:${record.ran} skipped:${record.skipped} deferred:${record.deferred} ` +
      `failed:${record.failed} graceful:${record.graceful}`,
  );
  for (const s of record.sections) {
    const detail = s.status === 'OK'
      ? `${s.elapsedSec ?? '?'}s records=${s.records ?? '?'}`
      : s.reason || '';
    console.log(`  ${s.status.padEnd(13)} ${s.label.padEnd(28)} ${detail}`);
    // Indented under the section it belongs to: on a container these lines are
    // the only account of what the seeder actually hit.
    for (const line of s.stderrTail || []) console.log(`      | ${line}`);
  }
}
