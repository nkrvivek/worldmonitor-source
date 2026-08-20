/**
 * Replays a URL corpus against Vercel and the local Worker and diffs routing.
 *
 * Compares status, Location, and the headers vercel.json actually sets.
 * Platform headers (Date, ETag, CF-*, X-Vercel-*) are ignored — they differ by
 * host, not by routing.
 *
 * Usage:
 *   npx wrangler dev            # in another shell
 *   npm run parity:routing
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const VERCEL_ORIGIN = process.env.PARITY_VERCEL_ORIGIN ?? 'https://www.worldmonitor.app';
const WORKER_ORIGIN = process.env.PARITY_WORKER_ORIGIN ?? 'http://localhost:8787';

const COMPARED_HEADERS = [
  'location',
  'cache-control',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'content-signal',
  'link',
  'access-control-allow-origin',
  'ratelimit-policy',
  'ratelimit-limit',
];

async function firstFileUnder(dir, prefix) {
  try {
    const entries = await readdir(join('dist', dir));
    const hit = entries.find((name) => name.startsWith(prefix));
    return hit ? `/${dir}/${hit}` : null;
  } catch {
    return null;
  }
}

async function buildCorpus() {
  const corpus = JSON.parse(
    await readFile('scripts/routing-parity-urls.json', 'utf8'),
  );
  const hashed = [
    await firstFileUnder('assets', ''),
    await firstFileUnder('blog/_astro', ''),
    await firstFileUnder('pro/assets', ''),
  ].filter(Boolean);
  for (const path of hashed) {
    corpus.push({ host: 'www.worldmonitor.app', path });
  }
  return corpus;
}

async function probe(origin, { host, path }) {
  const response = await fetch(`${origin}${path}`, {
    method: 'GET',
    headers: { Host: host },
    redirect: 'manual',
  });
  const headers = {};
  for (const key of COMPARED_HEADERS) {
    const value = response.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  // Drain so the socket closes; body bytes are Plan 4a's concern only via status.
  await response.arrayBuffer().catch(() => {});
  return { status: response.status, headers };
}

function diff(vercel, worker) {
  const problems = [];
  if (vercel.status !== worker.status) {
    problems.push(`status ${vercel.status} -> ${worker.status}`);
  }
  const keys = new Set([
    ...Object.keys(vercel.headers),
    ...Object.keys(worker.headers),
  ]);
  for (const key of keys) {
    if (vercel.headers[key] !== worker.headers[key]) {
      problems.push(
        `${key}: ${vercel.headers[key] ?? '(absent)'} -> ${worker.headers[key] ?? '(absent)'}`,
      );
    }
  }
  return problems;
}

const corpus = await buildCorpus();
let failures = 0;

for (const entry of corpus) {
  const [vercel, worker] = await Promise.all([
    probe(VERCEL_ORIGIN, entry),
    probe(WORKER_ORIGIN, entry),
  ]);
  const problems = diff(vercel, worker);
  if (problems.length === 0) continue;
  failures += 1;
  console.error(`MISMATCH ${entry.host}${entry.path}`);
  for (const problem of problems) console.error(`    ${problem}`);
}

console.log(`\n${corpus.length - failures}/${corpus.length} URLs match.`);
process.exit(failures === 0 ? 0 : 1);
