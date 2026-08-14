import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  isFirstPartyHost,
  isFirstPartyOrigin,
  resolveApiOrigin,
  resolveAppOrigin,
  resolveFirstPartyOrigin,
  resolveOrigins,
  resolvePublicBaseUrl,
} from '../api/_first-party-origin.ts';

const req = (host: string) => new Request(`https://${host}/oauth/authorize`, { headers: { host } });

describe('isFirstPartyHost', () => {
  it('accepts this fork and the upstream apex and subdomains', () => {
    assert.equal(isFirstPartyHost('worldmonitor.sibt.ai'), true);
    assert.equal(isFirstPartyHost('WorldMonitor.SIBT.ai'), true);
    assert.equal(isFirstPartyHost('worldmonitor.app'), true);
    assert.equal(isFirstPartyHost('api.worldmonitor.app'), true);
    assert.equal(isFirstPartyHost('www.worldmonitor.app'), true);
  });

  it('rejects lookalikes and deeper labels', () => {
    assert.equal(isFirstPartyHost('evil.com'), false);
    assert.equal(isFirstPartyHost('worldmonitor.app.evil.com'), false);
    assert.equal(isFirstPartyHost('evilworldmonitor.app'), false);
    assert.equal(isFirstPartyHost('a.b.worldmonitor.app'), false);
    assert.equal(isFirstPartyHost('worldmonitor.sibt.ai.evil.com'), false);
    assert.equal(isFirstPartyHost('evil.worldmonitor.sibt.ai'), false);
  });
});

describe('isFirstPartyOrigin', () => {
  it('accepts https origins on our hosts', () => {
    assert.equal(isFirstPartyOrigin('https://worldmonitor.sibt.ai'), true);
    assert.equal(isFirstPartyOrigin('https://api.worldmonitor.app'), true);
  });

  // The consent POST is gated on this. http, a port, or a path-carrying string
  // all mean the caller is not the page we served.
  it('rejects anything that is not a bare https origin of ours', () => {
    assert.equal(isFirstPartyOrigin('http://worldmonitor.sibt.ai'), false);
    assert.equal(isFirstPartyOrigin('https://worldmonitor.sibt.ai:8443'), false);
    assert.equal(isFirstPartyOrigin('https://evil.com'), false);
    assert.equal(isFirstPartyOrigin('null'), false);
    assert.equal(isFirstPartyOrigin(''), false);
  });
});

describe('origin resolvers', () => {
  it('sends every link on this fork back to this fork', () => {
    assert.equal(resolveFirstPartyOrigin(req('worldmonitor.sibt.ai')), 'https://worldmonitor.sibt.ai');
    assert.deepEqual(resolveOrigins(req('worldmonitor.sibt.ai')), {
      app: 'https://worldmonitor.sibt.ai',
      api: 'https://worldmonitor.sibt.ai',
    });
  });

  // Upstream's two-host split is unchanged: the page origin stays the apex and
  // the functions origin stays the api subdomain.
  it('keeps the upstream apex/api split', () => {
    assert.equal(resolveAppOrigin(req('worldmonitor.app')), 'https://worldmonitor.app');
    assert.equal(resolveApiOrigin(req('worldmonitor.app')), 'https://api.worldmonitor.app');
    assert.equal(resolveApiOrigin(req('www.worldmonitor.app')), 'https://api.worldmonitor.app');
  });

  // A spoofed Host must never become an origin we publish or redirect to.
  it('falls back to the upstream apex for an unknown host', () => {
    assert.equal(resolveFirstPartyOrigin(req('evil.example')), 'https://worldmonitor.app');
    assert.equal(resolveAppOrigin(req('evil.example')), 'https://worldmonitor.app');
    assert.equal(resolveApiOrigin(req('evil.example')), 'https://api.worldmonitor.app');
  });
});

// Every user-visible link an api/ handler mints — brief share URLs, referral
// links, the upgrade prompt, the "re-authorize" message — used to be built from
// a hardcoded https://worldmonitor.app. On this fork each one handed the reader
// to a site we do not run.
describe('resolvePublicBaseUrl', () => {
  const previous = process.env.WORLDMONITOR_PUBLIC_BASE_URL;
  const restore = () => {
    if (previous === undefined) delete process.env.WORLDMONITOR_PUBLIC_BASE_URL;
    else process.env.WORLDMONITOR_PUBLIC_BASE_URL = previous;
  };

  it('mints links on the host that served the request', () => {
    delete process.env.WORLDMONITOR_PUBLIC_BASE_URL;
    try {
      assert.equal(resolvePublicBaseUrl(req('worldmonitor.sibt.ai')), 'https://worldmonitor.sibt.ai');
      assert.equal(resolvePublicBaseUrl(req('worldmonitor.app')), 'https://worldmonitor.app');
    } finally {
      restore();
    }
  });

  it('prefers the pinned base URL and drops its trailing slashes', () => {
    process.env.WORLDMONITOR_PUBLIC_BASE_URL = 'https://staging.example.com//';
    try {
      assert.equal(resolvePublicBaseUrl(req('worldmonitor.sibt.ai')), 'https://staging.example.com');
    } finally {
      restore();
    }
  });

  // Host is client-controlled, so a spoofed one must never reach a link we hand
  // a reader.
  it('refuses a spoofed host', () => {
    delete process.env.WORLDMONITOR_PUBLIC_BASE_URL;
    try {
      assert.equal(resolvePublicBaseUrl(req('evil.example')), 'https://worldmonitor.app');
    } finally {
      restore();
    }
  });
});

// The sweep that fixed those links found six more sites on a second pass than
// on the first. Reading the tree by hand does not hold, so this keeps the list.
// A new upstream host written into api/ fails here until it is either derived
// from the request or named below with its reason.
describe('no upstream host is written into api/ by hand', () => {
  const KEEP: Record<string, string> = {
    'api/_first-party-origin.ts': 'the upstream constants themselves',
    'api/internal/china-exchange-egress.js': 'User-Agent string',
    'api/reverse-geocode.js': 'User-Agent string',
    'api/mcp/handler.ts': 'STATIC_ASSET_USER_AGENT',
    'api/mcp/ui/shell.ts': "upstream's own hosts in UI_CONNECT_DOMAINS",
    'api/youtube/embed.js': 'allowed-origin fallback, same class as _cors.js',
    'api/seed-contract-probe.ts': 'Origin header on a probe of ourselves',
    'api/internal/mcp-grant-mint.ts': "comments describing upstream's flow",
    'api/mcp/downstream.ts': 'classifies inbound upstream hosts — data, not links',
    'api/widget-agent.ts': 'relay host for a handler the worker does not route',
  };

  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return files(full);
      if (/\.test\.(ts|mts|js|mjs)$/.test(entry.name)) return [];
      return /\.(ts|mts|js|mjs)$/.test(entry.name) ? [full] : [];
    });

  it('every hardcoded worldmonitor.app is derived or named', () => {
    const offenders = files('api')
      .filter((file) => !file.endsWith('.generated.js'))
      .filter((file) => !(file in KEEP))
      .filter((file) => /https:\/\/(?:[a-z0-9-]+\.)?worldmonitor\.app/.test(readFileSync(file, 'utf8')));

    assert.deepEqual(
      offenders,
      [],
      `derive these from the request (api/_first-party-origin.ts) or add them to KEEP with a reason: ${offenders.join(', ')}`,
    );
  });

  // A keep entry that no longer matches is a stale exemption — it would hide
  // the next hardcoded host added to that file.
  it('every named exception still has one', () => {
    const stale = Object.keys(KEEP).filter(
      (file) => !/https:\/\/(?:[a-z0-9-]+\.)?worldmonitor\.app/.test(readFileSync(file, 'utf8')),
    );
    assert.deepEqual(stale, [], `drop these from KEEP: ${stale.join(', ')}`);
  });
});
