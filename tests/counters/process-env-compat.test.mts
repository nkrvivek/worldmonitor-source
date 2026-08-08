import { describe, expect, it } from 'vitest';

// Cloudflare's own docs: with the nodejs_compat compatibility flag AND a
// compatibility_date on or after 2025-04-01 (wrangler.jsonc's is
// "2026-08-02"), process.env is automatically and lazily populated from the
// Worker's vars and secret bindings -- no bridge code needed. Plan 4d, Task 1
// turns that flag on; everything server/gateway.ts and its shared imports
// read via process.env.X depends on this being true.
describe('nodejs_compat process.env', () => {
  it('populates process.env from the wrangler.jsonc vars binding', () => {
    expect(process.env.UPSTREAM_API_ORIGIN).toBe('https://vercel-origin.worldmonitor.app');
  });
});
