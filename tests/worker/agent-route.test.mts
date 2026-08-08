import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../worker/routes/agent', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/agent')>(
    '../../worker/routes/agent',
  );
  return {
    ...actual,
    handleAgent: vi.fn(async () => new Response('in-worker-agent', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import { handleAgent, isAgentPathHandledInWorker, AGENT_ROUTE_PATHS } from '../../worker/routes/agent';

function envWith(): Env {
  return {
    ASSETS: {
      async fetch() {
        return new Response('not found', { status: 404 });
      },
    },
    UPSTREAM_API_ORIGIN: 'https://vercel-origin.worldmonitor.app',
  };
}

describe('isAgentPathHandledInWorker', () => {
  // Named here rather than looped over the export alone: a path quietly dropped
  // from the table would still pass a loop over that same table.
  test('covers both front doors under both spellings', () => {
    expect([...AGENT_ROUTE_PATHS].sort()).toEqual(['/a2a', '/api/a2a', '/api/ask', '/ask']);
  });

  test('is true for every path in the table', () => {
    for (const path of AGENT_ROUTE_PATHS) {
      expect(isAgentPathHandledInWorker(path)).toBe(true);
    }
  });

  test('is true with a trailing slash', () => {
    expect(isAgentPathHandledInWorker('/ask/')).toBe(true);
  });

  // Exact paths, not prefixes. '/asking' and '/a2a-docs' are ordinary page
  // names, and the SPA catch-all must keep them.
  test('is false for neighbouring paths', () => {
    expect(isAgentPathHandledInWorker('/asking')).toBe(false);
    expect(isAgentPathHandledInWorker('/a2a-docs')).toBe(false);
    expect(isAgentPathHandledInWorker('/ask/query')).toBe(false);
    expect(isAgentPathHandledInWorker('/api/a2a/send')).toBe(false);
  });
});

describe('worker fetch: agent routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards: an agent read our agent card, POSTed to /a2a, and hit
  // the UPSTREAM_API_ORIGIN proxy, whose host does not resolve. Every A2A and
  // NLWeb call ended in a 530.
  test.each([...AGENT_ROUTE_PATHS])('%s answers from the Worker, not the Vercel proxy', async (path) => {
    const seen: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response('upstream:proxied', { status: 200 });
    }) as typeof fetch;
    try {
      const req = new Request(`https://worldmonitor.sibt.ai${path}`, { method: 'POST' });
      const res = await worker.fetch(req, envWith());
      expect(await res.text()).toBe('in-worker-agent');
      expect(handleAgent).toHaveBeenCalledTimes(1);
      expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
