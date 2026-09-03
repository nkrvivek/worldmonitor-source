import { describe, it, expect } from 'vitest';
import { handleAisSnapshot } from '../../worker/routes/ais-snapshot';

interface RelayBinding {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

const SNAPSHOT_BODY = {
  sequence: 1,
  timestamp: 0,
  status: { connected: false, vessels: 0, messages: 0, clients: 0, droppedMessages: 0 },
  disruptions: [],
  density: [],
};

/**
 * Records the URL the route forwarded, so a test can assert the query string
 * survives the hop to the DO's own internal path.
 */
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
          return Response.json(SNAPSHOT_BODY);
        },
      }),
    } as RelayBinding | undefined,
    ...overrides,
  };
  return { env, forwarded };
}

function authorized(url = 'https://worldmonitor.sibt.ai/ais/snapshot') {
  return new Request(url, { headers: { 'x-relay-key': 'the-real-secret' } });
}

describe('handleAisSnapshot', () => {
  it('returns 401 without a valid secret', async () => {
    const { env } = fakeEnv();
    const response = await handleAisSnapshot(
      new Request('https://worldmonitor.sibt.ai/ais/snapshot'),
      env,
    );
    expect(response.status).toBe(401);
  });

  it('returns 401 when the presented secret is wrong', async () => {
    const { env } = fakeEnv();
    const request = new Request('https://worldmonitor.sibt.ai/ais/snapshot', {
      headers: { 'x-relay-key': 'not-the-secret' },
    });
    expect((await handleAisSnapshot(request, env)).status).toBe(401);
  });

  it('forwards a valid request to the DO and returns its response', async () => {
    const { env } = fakeEnv();
    const response = await handleAisSnapshot(authorized(), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sequence: number };
    expect(body.sequence).toBe(1);
  });

  it('carries the query string through to the DO', async () => {
    const { env, forwarded } = fakeEnv();
    await handleAisSnapshot(
      authorized('https://worldmonitor.sibt.ai/ais/snapshot?tankers=true&bbox=0,0,5,5'),
      env,
    );
    // The public path is /ais/snapshot; the DO answers its own /snapshot. The
    // filters have to survive that translation or every caller silently gets
    // an unfiltered snapshot.
    expect(forwarded).toHaveLength(1);
    const target = new URL(forwarded[0] as string);
    expect(target.pathname).toBe('/snapshot');
    expect(target.searchParams.get('tankers')).toBe('true');
    expect(target.searchParams.get('bbox')).toBe('0,0,5,5');
  });

  it('returns 500 when the AIS_RELAY binding is missing', async () => {
    const { env } = fakeEnv({ AIS_RELAY: undefined });
    expect((await handleAisSnapshot(authorized(), env)).status).toBe(500);
  });
});
