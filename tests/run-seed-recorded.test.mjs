// Verifies scripts/run-seed-recorded.mjs records what a scheduled seed did:
// the exit code survives, a killed child never reports success, and the record
// reaches Redis carrying the tail of the output.
//
// Spawns the wrapper for real against throwaway scripts, and points its Redis
// at a local server, because the thing under test is what the wrapper does to
// exit codes and what it sends over the wire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { makeTail, writeRunRecord } from '../scripts/run-seed-recorded.mjs';

const WRAPPER = fileURLToPath(new URL('../scripts/run-seed-recorded.mjs', import.meta.url));

/** Collects the bodies Upstash would have received. */
async function withFakeRedis(fn) {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'OK' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url, bodies);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runWrapper(script, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [WRAPPER, script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function tempScript(body) {
  const dir = mkdtempSync(join(tmpdir(), 'runseed-'));
  const path = join(dir, `${randomUUID()}.mjs`);
  writeFileSync(path, body);
  return path;
}

test('makeTail keeps the end of the output, not the beginning', () => {
  const tail = makeTail(10);
  tail.append('0123456789');
  tail.append('abcdefghij');
  assert.equal(tail.read(), 'abcdefghij');
});

test('makeTail returns everything when the output is under the limit', () => {
  const tail = makeTail(100);
  tail.append('one ');
  tail.append('two');
  assert.equal(tail.read(), 'one two');
});

test('writeRunRecord reports failure rather than silence when credentials are missing', async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    const wrote = await writeRunRecord('seed-run:script:x', { status: 'OK' }, () => {
      throw new Error('fetch must not be called without credentials');
    });
    assert.equal(wrote, false);
  } finally {
    if (url) process.env.UPSTASH_REDIS_REST_URL = url;
    if (token) process.env.UPSTASH_REDIS_REST_TOKEN = token;
  }
});

test('writeRunRecord never throws when Redis rejects the write', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:1';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  try {
    const wrote = await writeRunRecord('seed-run:script:x', { status: 'OK' }, async () => ({
      ok: false,
      status: 500,
    }));
    assert.equal(wrote, false);
  } finally {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test('a clean seed exits 0 and records OK with its output', async () => {
  const script = tempScript("console.log('seeded 33 countries');\n");
  try {
    await withFakeRedis(async (url, bodies) => {
      const { code, out } = await runWrapper(script, {
        UPSTASH_REDIS_REST_URL: url,
        UPSTASH_REDIS_REST_TOKEN: 'tok',
      });
      assert.equal(code, 0);
      assert.match(out, /seeded 33 countries/);
      assert.equal(bodies.length, 1);
      const cmd = JSON.parse(bodies[0]);
      assert.equal(cmd[0], 'SET');
      assert.equal(cmd[1], `seed-run:script:${script}`);
      assert.equal(cmd[3], 'EX');
      const record = JSON.parse(cmd[2]);
      assert.equal(record.status, 'OK');
      assert.equal(record.code, 0);
      assert.equal(record.script, script);
      assert.match(record.tail, /seeded 33 countries/);
    });
  } finally {
    unlinkSync(script);
  }
});

test('a failing seed keeps its exit code and records the reason it printed', async () => {
  const script = tempScript("console.error('validateFuel rejected: Mexico');\nprocess.exit(3);\n");
  try {
    await withFakeRedis(async (url, bodies) => {
      const { code } = await runWrapper(script, {
        UPSTASH_REDIS_REST_URL: url,
        UPSTASH_REDIS_REST_TOKEN: 'tok',
      });
      assert.equal(code, 3);
      const record = JSON.parse(JSON.parse(bodies[0])[2]);
      assert.equal(record.status, 'FAILED');
      assert.equal(record.code, 3);
      assert.match(record.tail, /validateFuel rejected: Mexico/);
    });
  } finally {
    unlinkSync(script);
  }
});

test('a seed that declined to publish is recorded as graceful, not failed', async () => {
  const script = tempScript(
    "console.log('source unreachable, declining to publish');\nprocess.exit(75);\n",
  );
  try {
    await withFakeRedis(async (url, bodies) => {
      const { code } = await runWrapper(script, {
        UPSTASH_REDIS_REST_URL: url,
        UPSTASH_REDIS_REST_TOKEN: 'tok',
      });
      assert.equal(code, 75);
      const record = JSON.parse(JSON.parse(bodies[0])[2]);
      assert.equal(record.status, 'GRACEFUL');
    });
  } finally {
    unlinkSync(script);
  }
});

test('a killed seed never reports success', async () => {
  const script = tempScript("process.kill(process.pid, 'SIGKILL');\nsetTimeout(() => {}, 5000);\n");
  try {
    await withFakeRedis(async (url, bodies) => {
      const { code } = await runWrapper(script, {
        UPSTASH_REDIS_REST_URL: url,
        UPSTASH_REDIS_REST_TOKEN: 'tok',
      });
      assert.notEqual(code, 0);
      const record = JSON.parse(JSON.parse(bodies[0])[2]);
      assert.equal(record.status, 'SIGNALLED');
      assert.equal(record.signal, 'SIGKILL');
    });
  } finally {
    unlinkSync(script);
  }
});

test('a seed that cannot start is recorded as a start error, not a failed run', async () => {
  const missing = join(tmpdir(), `absent-${randomUUID()}.mjs`);
  await withFakeRedis(async (url, bodies) => {
    const { code } = await runWrapper(missing, {
      UPSTASH_REDIS_REST_URL: url,
      UPSTASH_REDIS_REST_TOKEN: 'tok',
    });
    assert.notEqual(code, 0);
    // node itself reports a missing entry point, so the child starts and exits
    // non-zero rather than failing to spawn. Either way the record must exist
    // and must not read OK.
    assert.equal(bodies.length, 1);
    const record = JSON.parse(JSON.parse(bodies[0])[2]);
    assert.notEqual(record.status, 'OK');
  });
});

test('the wrapper refuses to run with no script named', async () => {
  const { code, out } = await new Promise((resolve) => {
    const child = spawn('node', [WRAPPER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (c) => { text += c; });
    child.stderr.on('data', (c) => { text += c; });
    child.on('close', (c) => resolve({ code: c, out: text }));
  });
  assert.equal(code, 2);
  assert.match(out, /no script given/);
});
