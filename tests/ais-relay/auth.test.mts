import { describe, it, expect } from 'vitest';
import {
  timingSafeEqualStrings,
  getRelaySecretFromRequest,
  isAuthorizedRelayRequest,
} from '../../worker/ais/auth';

describe('timingSafeEqualStrings', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualStrings('same-secret', 'same-secret')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeEqualStrings('same-secret', 'diff-secret')).toBe(false);
  });

  it('returns false for different-length strings without throwing', () => {
    expect(timingSafeEqualStrings('short', 'much-longer-string')).toBe(false);
  });

  it('returns false when either side is empty', () => {
    expect(timingSafeEqualStrings('', 'nonempty')).toBe(false);
    expect(timingSafeEqualStrings('nonempty', '')).toBe(false);
  });
});

describe('getRelaySecretFromRequest', () => {
  it('reads the configured header first', () => {
    const request = new Request('https://relay.internal/ais/snapshot', {
      headers: { 'x-relay-key': 'from-header' },
    });
    expect(getRelaySecretFromRequest(request, 'x-relay-key')).toBe('from-header');
  });

  it('falls back to Authorization: Bearer when the header is absent', () => {
    const request = new Request('https://relay.internal/ais/snapshot', {
      headers: { authorization: 'Bearer from-bearer' },
    });
    expect(getRelaySecretFromRequest(request, 'x-relay-key')).toBe('from-bearer');
  });

  it('returns null when neither is present', () => {
    const request = new Request('https://relay.internal/ais/snapshot');
    expect(getRelaySecretFromRequest(request, 'x-relay-key')).toBeNull();
  });

  it('trims whitespace and rejects an empty header value', () => {
    const request = new Request('https://relay.internal/ais/snapshot', {
      headers: { 'x-relay-key': '   ' },
    });
    expect(getRelaySecretFromRequest(request, 'x-relay-key')).toBeNull();
  });
});

describe('isAuthorizedRelayRequest', () => {
  it('authorizes a matching secret via the configured header', () => {
    const request = new Request('https://relay.internal/ais/snapshot', {
      headers: { 'x-relay-key': 'the-real-secret' },
    });
    const env = { RELAY_SHARED_SECRET: 'the-real-secret', RELAY_AUTH_HEADER: 'x-relay-key' };
    expect(isAuthorizedRelayRequest(request, env)).toBe(true);
  });

  it('rejects a mismatched secret', () => {
    const request = new Request('https://relay.internal/ais/snapshot', {
      headers: { 'x-relay-key': 'wrong' },
    });
    const env = { RELAY_SHARED_SECRET: 'the-real-secret', RELAY_AUTH_HEADER: 'x-relay-key' };
    expect(isAuthorizedRelayRequest(request, env)).toBe(false);
  });

  it('fails closed when RELAY_SHARED_SECRET is not configured', () => {
    const request = new Request('https://relay.internal/ais/snapshot', {
      headers: { 'x-relay-key': 'anything' },
    });
    expect(isAuthorizedRelayRequest(request, {})).toBe(false);
  });

  it('defaults the header name to x-relay-key when RELAY_AUTH_HEADER is unset', () => {
    const request = new Request('https://relay.internal/ais/snapshot', {
      headers: { 'x-relay-key': 'the-real-secret' },
    });
    expect(isAuthorizedRelayRequest(request, { RELAY_SHARED_SECRET: 'the-real-secret' })).toBe(true);
  });
});
