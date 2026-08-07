#!/usr/bin/env node

// Last gate before the tracked tree is published to a public repo.
//
// The mirror exists to satisfy AGPL-3.0-only section 13: worldmonitor.sibt.ai
// runs a modified version, so anyone using it over the network is owed THIS
// source, not upstream's. .github/workflows/publish-source-mirror.yml pushes
// the tree to nkrvivek/worldmonitor-source, and a private repo going public is
// a one-way door — a key that lands there is a key that has to be rotated.
//
// Two rules, and both are about values rather than words. Naming a variable
// STRIPE_SECRET_KEY in code is fine and unavoidable; carrying its value is not.
// So every pattern here requires a body of the right shape and length, and
// prose about key prefixes does not trip it.
//
// Publishable keys are deliberately absent: pk_live_, the Supabase anon key and
// VITE_CONVEX_URL are client values, shipped in the browser bundle already, and
// .env.production tracks them on purpose.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Files that may not be published at all, whatever is inside them. Matched
// against the repo-relative path. .env.production is the one env file that is
// tracked on purpose (client values only) and is not listed here.
const FORBIDDEN_PATHS = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.local$/,
  /(^|\/)\.env\.development(\.local)?$/,
  /(^|\/)\.env\.production\.local$/,
  /(^|\/)\.dev\.vars$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/,
  /\.(pem|p12|pfx|keystore|jks)$/,
];

// Each pattern needs a plausible secret body, not just the prefix word.
const SECRET_PATTERNS = [
  { name: 'Stripe secret or restricted key', re: /\b[sr]k_(live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'Stripe webhook signing secret', re: /\bwhsec_[A-Za-z0-9+/=]{24,}/ },
  { name: 'Resend API key', re: /\bre_[A-Za-z0-9]{16,}_[A-Za-z0-9]{16,}/ },
  { name: 'WorldMonitor operator key', re: /\bwmops_[a-f0-9]{64}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'OpenAI API key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/ },
  { name: 'private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'signed JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

const JWT_RE = SECRET_PATTERNS.find((p) => p.name === 'signed JWT').re;

/**
 * True for the one JWT that belongs in a public tree: the Supabase anon key.
 *
 * It is a client credential — the browser bundle ships it, Row Level Security
 * is what actually guards the data, and .env.production tracks it on purpose.
 * Decoding rather than pattern-matching keeps `"role":"service_role"` caught,
 * which is the key that would matter.
 */
function isPublishableJwt(token) {
  try {
    const payload = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
    return JSON.parse(payload).role === 'anon';
  } catch {
    return false;
  }
}

// Fixture JWTs and sample keys the tests need. A line ending in this marker is
// exempt, so an exemption is visible at the point it is granted rather than in
// a list somewhere else.
const ALLOW_MARKER = 'mirror-scan-allow';

/** Files git tracks, which is exactly what the mirror publishes. */
export function trackedFiles(cwd) {
  return execFileSync('git', ['ls-files', '-z'], { cwd, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/**
 * Findings for one file's text. Returns [] when clean.
 *
 * Binary files are skipped rather than decoded: a JPEG's bytes will eventually
 * spell something that matches, and an image cannot carry a key we would leak
 * by publishing the repo that already contains it.
 */
export function scanText(path, text) {
  const findings = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      const hit = line.match(re);
      if (!hit) continue;
      if (re === JWT_RE && line.match(new RegExp(JWT_RE, 'g')).every(isPublishableJwt)) continue;
      findings.push({ path, line: i + 1, name });
    }
  }
  return findings;
}

export function scanPath(path) {
  return FORBIDDEN_PATHS.some((re) => re.test(path))
    ? [{ path, line: 0, name: 'file must never be published' }]
    : [];
}

function isProbablyBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

export function scanTree(cwd) {
  const findings = [];
  for (const path of trackedFiles(cwd)) {
    findings.push(...scanPath(path));
    let buf;
    try {
      buf = readFileSync(`${cwd}/${path}`);
    } catch {
      continue; // submodule or broken symlink — nothing to read, nothing to leak
    }
    if (isProbablyBinary(buf)) continue;
    findings.push(...scanText(path, buf.toString('utf8')));
  }
  return findings;
}

const isMain = process.argv[1]?.endsWith('scan-source-mirror-secrets.mjs');

if (isMain) {
  const cwd = process.argv[2] ?? process.cwd();
  const findings = scanTree(cwd);
  if (findings.length === 0) {
    console.log('source mirror scan: clean');
    process.exit(0);
  }
  // The value itself is never printed. A path and a line number are enough to
  // find it, and this log is public.
  console.error(`source mirror scan: ${findings.length} finding(s) — refusing to publish`);
  for (const f of findings) console.error(`  ${f.path}:${f.line}  ${f.name}`);
  process.exit(1);
}
