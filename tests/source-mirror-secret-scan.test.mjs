import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanText, scanPath, scanTree } from '../.github/scripts/scan-source-mirror-secrets.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Assembled rather than written out. GitHub's own push protection reads a
// literal sk_live_ key as the real thing and refuses the push — which is how
// the mirror's first run failed, on this file. Joining the parts keeps the
// fixture out of every scanner's way, including ours.
const STRIPE_FIXTURE = ['sk', 'live', '51ABCdefGHIjklMNOpqrsTUVwxyz012345'].join('_');

// A Supabase anon key: role "anon", signed, and shipped in the browser bundle.
// Built here rather than pasted so the test says why it is allowed.
function anonJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role: 'anon' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
}

function serviceRoleJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role: 'service_role' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
}

describe('source mirror secret scan', () => {
  it('passes a variable name carrying no value', () => {
    assert.deepEqual(scanText('a.ts', 'const key = process.env.STRIPE_SECRET_KEY;'), []);
  });

  it('passes prose about a key prefix', () => {
    assert.deepEqual(scanText('doc.md', 'Live keys start with sk_live_ and are never committed.'), []);
  });

  it('catches a Stripe secret key', () => {
    const found = scanText('a.ts', `const k = "${STRIPE_FIXTURE}";`);
    assert.equal(found.length, 1);
    assert.match(found[0].name, /Stripe secret/);
  });

  it('catches a private key block', () => {
    assert.equal(scanText('k.txt', '-----BEGIN OPENSSH PRIVATE KEY-----').length, 1); // mirror-scan-allow
  });

  // The mirror deploy key lives in GitHub secrets, never in the tree. If one
  // ever lands as a file, no pattern inside it needs to match for us to refuse.
  it('refuses forbidden paths whatever they contain', () => {
    assert.equal(scanPath('.env.local').length, 1);
    assert.equal(scanPath('certs/server.pem').length, 1);
    assert.deepEqual(scanPath('.env.production'), []);
  });

  it('allows the Supabase anon key and still catches the service-role key', () => {
    assert.deepEqual(scanText('bundle.js', `const k="${anonJwt()}"`), []);
    assert.equal(scanText('bundle.js', `const k="${serviceRoleJwt()}"`).length, 1);
  });

  it('honours an inline allow marker', () => {
    assert.deepEqual(scanText('t.test.mjs', `${STRIPE_FIXTURE} // mirror-scan-allow`), []);
  });

  // The gate itself. .github/workflows/publish-source-mirror.yml runs the same
  // scan before it pushes, so a key committed here fails the suite first —
  // which is the point: a private repo published publicly is a one-way door.
  //
  // "Tracked" is git ls-files, so a file that is not added yet is invisible to
  // this test and visible to CI. That gap caught this very file on its first
  // run: its own fixtures tripped the scan the moment they were committed.
  it('finds nothing in the tracked tree', () => {
    const findings = scanTree(REPO_ROOT);
    const where = findings.map((f) => `${f.path}:${f.line} ${f.name}`).join('\n');
    assert.equal(findings.length, 0, `tracked files carry secrets:\n${where}`);
  });
});
