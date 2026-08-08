import { describe, it, expect } from 'vitest';
import { handleAisTransits } from '../../worker/routes/ais-snapshot';

interface RelayBinding {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

const TRANSITS_BODY = {
  transits: { 'Suez Canal': { tanker: 3, cargo: 5, other: 1, total: 9 } },
  fetchedAt: 0,
  windowHours: 24,
  connected: true,
  vessels: 8000,
};

function fakeEnv(
  overrides: Partial<{
    RELAY_SHARED_SECRET: string;
    RELAY_AUTH_HEADER: string;
    AIS_RELAY: RelayBinding | undefined;
  }> = {},
) {
  const forwarded: string[] = [];
  const env = {
    RELAY_SHARED_SECRET: 'the-real-secret',
    RELAY_AUTH_HEADER: 'x-relay-key',
    AIS_RELAY: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          forwarded.push(request.url);
          return Response.json(TRANSITS_BODY);
        },
      }),
    } as RelayBinding | undefined,
    ...overrides,
  };
  return { env, forwarded };
}

function authorized() {
  return new Request('https://worldmonitor.sibt.ai/ais/transits', {
    headers: { 'x-relay-key': 'the-real-secret' },
  });
}

describe('handleAisTransits', () => {
  it('returns 401 without a valid secret', async () => {
    const { env } = fakeEnv();
    const response = await handleAisTransits(
      new Request('https://worldmonitor.sibt.ai/ais/transits'),
      env,
    );
    expect(response.status).toBe(401);
  });

  it('returns 401 when the presented secret is wrong', async () => {
    const { env } = fakeEnv();
    const request = new Request('https://worldmonitor.sibt.ai/ais/transits', {
      headers: { 'x-relay-key': 'not-the-secret' },
    });
    expect((await handleAisTransits(request, env)).status).toBe(401);
  });

  it('forwards a valid request to the DO and returns its response', async () => {
    const { env, forwarded } = fakeEnv();
    const response = await handleAisTransits(authorized(), env);
    expect(response.status).toBe(200);

    // The public path is /ais/transits; the DO answers its own /transits.
    expect(forwarded).toHaveLength(1);
    expect(new URL(forwarded[0] as string).pathname).toBe('/transits');

    const body = (await response.json()) as typeof TRANSITS_BODY;
    expect(body.connected).toBe(true);
    expect(body.transits['Suez Canal']?.total).toBe(9);
  });

  it('returns 500 when the AIS_RELAY binding is missing', async () => {
    const { env } = fakeEnv({ AIS_RELAY: undefined });
    expect((await handleAisTransits(authorized(), env)).status).toBe(500);
  });
});
