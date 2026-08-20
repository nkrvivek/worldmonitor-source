import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ISSUER = 'https://twyzyvgqzzuvlvsftcjj.supabase.co/auth/v1';

async function loadConfig() {
  vi.resetModules();
  const mod = await import('../auth.config');
  return mod.default as { providers: Array<{ domain: string; applicationID: string }> };
}

describe('convex auth config', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.SUPABASE_JWT_ISSUER;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  // Supabase's JWT audience is the fixed string "authenticated" -- it is not
  // configurable, and it is not the app name. Carrying Clerk's "convex" over
  // would leave every token failing audience validation inside Convex while
  // the client believed it was signed in, so this value gets its own test.
  test('names the audience Supabase actually issues', async () => {
    process.env.SUPABASE_JWT_ISSUER = ISSUER;
    const config = await loadConfig();
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].applicationID).toBe('authenticated');
  });

  test('takes the issuer from the environment', async () => {
    process.env.SUPABASE_JWT_ISSUER = ISSUER;
    const config = await loadConfig();
    expect(config.providers[0].domain).toBe(ISSUER);
  });

  // Fail loudly at deploy time. An unset issuer would otherwise produce a
  // provider entry with an empty domain, which accepts nothing and reports
  // nothing -- sign-in would simply never work.
  test('refuses to load without an issuer', async () => {
    await expect(loadConfig()).rejects.toThrow('SUPABASE_JWT_ISSUER is not set');
  });
});
