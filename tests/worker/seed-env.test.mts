import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SEED_ENV_NAMES, SEED_ENV_NOT_FORWARDED, seedEnvVars } from '../../worker/seeds/env';
import { SEED_JOBS } from '../../worker/seeds/registry';

const scriptsDir = fileURLToPath(new URL('../../scripts/', import.meta.url));

/**
 * Every script a cron can reach: the registry entries, plus the members each
 * bundle declares, followed until the set stops growing.
 */
function reachableScripts(): string[] {
  const seen = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const path = scriptsDir + name;
    if (!existsSync(path)) return;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/script:\s*'(seed-[^']+\.mjs)'/g)) {
      const member = match[1];
      if (member) walk(member);
    }
  };
  for (const job of SEED_JOBS) {
    for (const script of job.scripts) walk(script.replace('scripts/', ''));
  }
  return [...seen];
}

/** The helpers every seed imports, which read env of their own. */
function sharedHelpers(): string[] {
  const top = readdirSync(scriptsDir).filter((f) => f.startsWith('_') && f.endsWith('.mjs'));
  const lib = readdirSync(scriptsDir + 'lib').map((f) => 'lib/' + f);
  return [...top, ...lib.filter((f) => f.endsWith('.mjs'))];
}

function envNamesRead(file: string): string[] {
  const source = readFileSync(scriptsDir + file, 'utf8');
  return [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)]
    .map((m) => m[1])
    .filter((name): name is string => Boolean(name));
}

describe('seedEnvVars', () => {
  it('forwards the named secrets the Worker carries', () => {
    // Arrange
    const env = {
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    };

    // Act
    const vars = seedEnvVars(env);

    // Assert
    expect(vars).toEqual({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
  });

  it('drops a name the Worker does not carry rather than passing undefined', () => {
    // Arrange
    const env = { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' };

    // Act
    const vars = seedEnvVars(env);

    // Assert
    expect('UPSTASH_REDIS_REST_TOKEN' in vars).toBe(false);
  });

  it('drops an empty value, so a blank secret reads as unset inside the container', () => {
    // Arrange — _bundle-runner.mjs treats a blank string as missing and skips
    // the section. Forwarding "" would make that check pass on nothing.
    const env = { PROXY_URL: '   ', COMTRADE_API_KEYS: '' };

    // Act
    const vars = seedEnvVars(env);

    // Assert
    expect(vars).toEqual({});
  });

  it('forwards nothing that is not on the list', () => {
    // Arrange
    const env = { WM_SESSION_SECRET: 'signing key', SOME_OTHER: 'x' };

    // Act
    const vars = seedEnvVars(env);

    // Assert
    expect(vars).toEqual({});
  });

  it('ignores a binding that is not a string, such as a KV namespace', () => {
    // Arrange
    const env = { UPSTASH_REDIS_REST_URL: { get: () => null } };

    // Act
    const vars = seedEnvVars(env);

    // Assert
    expect(vars).toEqual({});
  });

  it('never lists the session signing secret, which no seed script reads', () => {
    expect(SEED_ENV_NAMES).not.toContain('WM_SESSION_SECRET');
  });
});

describe('the allowlist against what the scripts read', () => {
  // A container inherits nothing, so a name a reachable script reads and this
  // list does not carry is a seed that runs and writes nothing. That gap sat
  // unread until 2026-08-05, when 97 health checks reported EMPTY and three of
  // them traced straight back to it.
  const ignored = new Set(['NODE_ENV', 'CI', 'DEBUG']);

  it('forwards, or records a reason for, every name a reachable seed reads', () => {
    // Arrange
    const files = [...reachableScripts(), ...sharedHelpers()].filter((f) =>
      existsSync(scriptsDir + f),
    );

    // Act
    const unaccounted = new Map<string, string[]>();
    for (const file of files) {
      for (const name of envNamesRead(file)) {
        if (ignored.has(name)) continue;
        if ((SEED_ENV_NAMES as readonly string[]).includes(name)) continue;
        if (name in SEED_ENV_NOT_FORWARDED) continue;
        unaccounted.set(name, [...(unaccounted.get(name) ?? []), file]);
      }
    }

    // Assert
    expect(
      [...unaccounted].map(([name, readers]) => `${name} (${readers.join(', ')})`),
    ).toEqual([]);
  });

  it('keeps the exclusion list to names a seed actually reads', () => {
    // Arrange — a stale exclusion hides nothing, but it does misdescribe the
    // rail, and the next reader trusts it.
    const read = new Set(
      [...reachableScripts(), ...sharedHelpers()]
        .filter((f) => existsSync(scriptsDir + f))
        .flatMap(envNamesRead),
    );

    // Act
    const orphans = Object.keys(SEED_ENV_NOT_FORWARDED).filter((n) => !read.has(n));

    // Assert
    expect(orphans).toEqual([]);
  });

  // Added 2026-08-24. WORLDMONITOR_SEED_REFRESH_KEY sat in the exclusion list
  // under "self-call credential; no reachable seed needs it" from before the
  // resilience bundle joined the registry. Once it did, every 6-hourly
  // container tick died in 671ms on
  // "[Resilience-Scores] FATAL: WORLDMONITOR_SEED_REFRESH_KEY is required for
  // resilience ranking refresh" while the two tests above stayed green: a name
  // in the exclusion list is accounted for, and the script did read it, so
  // neither had anything to say. An excuse and a hard requirement are not the
  // same claim, and only this test tells them apart.
  it('never excuses a name a reachable seed refuses to run without', () => {
    // Arrange
    const excused = Object.keys(SEED_ENV_NOT_FORWARDED);
    const files = [...reachableScripts(), ...sharedHelpers()].filter((f) =>
      existsSync(scriptsDir + f),
    );

    // Act — a name written into a throw or a FATAL line is a hard requirement,
    // whatever the exclusion list says about it.
    const required = new Map<string, string[]>();
    for (const file of files) {
      const source = readFileSync(scriptsDir + file, 'utf8');
      const fatals = [
        ...source.matchAll(/throw new Error\(([\s\S]{0,300}?)\)/g),
        ...source.matchAll(/FATAL:([^\n]{0,300})/g),
      ].map((m) => m[1] ?? '');
      for (const name of excused) {
        if (!fatals.some((text) => text.includes(name))) continue;
        required.set(name, [...(required.get(name) ?? []), file]);
      }
    }

    // Assert
    expect(
      [...required].map(([name, readers]) => `${name} (${readers.join(', ')})`),
    ).toEqual([]);
  });

  it('gives every excluded name a reason, not a blank', () => {
    const blank = Object.entries(SEED_ENV_NOT_FORWARDED)
      .filter(([, reason]) => reason.trim() === '')
      .map(([name]) => name);
    expect(blank).toEqual([]);
  });
});
