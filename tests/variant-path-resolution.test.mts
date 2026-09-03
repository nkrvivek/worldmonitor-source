import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VARIANT_META } from '../src/config/variant-meta';
import { resolveSiteVariant } from '../src/config/variant';

// Upstream gives every variant its own subdomain and reads the variant back
// off the hostname. This fork serves all six as paths on one host, and the
// switcher already navigates to those paths (VARIANT_META.url,
// tests/variant-navigation.test.mts). Reading the hostname alone therefore
// answered 'full' for every one of them, so every switch landed on the same
// dashboard. These cases pin both rules: the subdomain one upstream still
// needs, and the path one this host runs on.
const FORK_HOST = 'worldmonitor.sibt.ai';

function resolve(overrides: Partial<Parameters<typeof resolveSiteVariant>[0]>) {
  return resolveSiteVariant({
    hostname: FORK_HOST,
    pathname: '/',
    isDesktopApp: false,
    storedVariant: null,
    buildVariant: 'full',
    ...overrides,
  });
}

describe('resolveSiteVariant', () => {
  it('reads the variant off its own path on this host', () => {
    for (const [variant, meta] of Object.entries(VARIANT_META)) {
      const { pathname } = new URL(meta.url);
      assert.equal(resolve({ pathname }), variant, `${pathname} should serve the ${variant} variant`);
    }
  });

  it('ignores a trailing slash and letter case in the path', () => {
    assert.equal(resolve({ pathname: '/tech/' }), 'tech');
    assert.equal(resolve({ pathname: '/TECH' }), 'tech');
  });

  it('still reads upstream subdomains, which win over the path', () => {
    assert.equal(resolve({ hostname: 'tech.worldmonitor.app' }), 'tech');
    assert.equal(resolve({ hostname: 'energy.worldmonitor.app' }), 'energy');
    assert.equal(
      resolve({ hostname: 'finance.worldmonitor.app', pathname: '/tech' }),
      'finance',
      'a variant subdomain names the deployment; the path inside it does not override it',
    );
  });

  it('answers full for a path that is not a variant route', () => {
    assert.equal(resolve({ pathname: '/' }), 'full');
    assert.equal(resolve({ pathname: '/pricing' }), 'full');
  });

  it('reads the stored variant on the desktop app and on local dev', () => {
    assert.equal(resolve({ isDesktopApp: true, storedVariant: 'happy' }), 'happy');
    assert.equal(resolve({ hostname: 'localhost', storedVariant: 'commodity' }), 'commodity');
    assert.equal(resolve({ hostname: '127.0.0.1', storedVariant: 'commodity' }), 'commodity');
  });

  it('lets a stored variant beat the path on local dev, where switching reloads in place', () => {
    // navigateToVariant() writes localStorage and reloads on local dev instead
    // of navigating, so the old path survives the switch. If the path won here,
    // the switcher would silently undo itself.
    assert.equal(resolve({ hostname: 'localhost', pathname: '/tech', storedVariant: 'finance' }), 'finance');
  });

  it('survives a location with no pathname', () => {
    // SITE_VARIANT resolves at import time against an ambient location this
    // module does not own, and several suites stub only a hostname. Throwing
    // here takes down every test that imports anything reaching this file.
    assert.equal(resolve({ pathname: undefined }), 'full');
  });

  it('falls back to the build variant when nothing else names one', () => {
    assert.equal(resolve({ isDesktopApp: true, buildVariant: 'energy' }), 'energy');
    assert.equal(resolve({ hostname: 'localhost', storedVariant: 'nonsense', buildVariant: 'tech' }), 'tech');
  });
});
