import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../worker/routes/mcp', async () => {
  const actual = await vi.importActual<typeof import('../../worker/routes/mcp')>(
    '../../worker/routes/mcp',
  );
  return {
    ...actual,
    handleMcpRpc: vi.fn(async () => new Response('in-worker-mcp', { status: 200 })),
  };
});

import worker, { type Env } from '../../worker/index';
import { handleMcpRpc, isMcpPathHandledInWorker, MCP_ROUTE_PATHS } from '../../worker/routes/mcp';

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

describe('isMcpPathHandledInWorker', () => {
  // Named here rather than looped over the export alone: a path quietly dropped
  // from the table would still pass a loop over that same table.
  test('covers exactly the MCP front door and its discovery documents', () => {
    expect([...MCP_ROUTE_PATHS].sort()).toEqual([
      '/.well-known/http-message-signatures-directory',
      '/.well-known/mcp',
      '/.well-known/mcp.json',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/api/mcp',
      '/mcp',
    ]);
  });

  test('is true for every path in the table', () => {
    for (const path of MCP_ROUTE_PATHS) {
      expect(isMcpPathHandledInWorker(path)).toBe(true);
    }
  });

  test('is true with a trailing slash', () => {
    expect(isMcpPathHandledInWorker('/mcp/')).toBe(true);
  });

  // Exact paths, not prefixes. '/mcp-grant' is a real page on this site and a
  // prefix match would swallow it into the JSON-RPC handler.
  test('is false for neighbouring paths', () => {
    expect(isMcpPathHandledInWorker('/mcp-grant')).toBe(false);
    expect(isMcpPathHandledInWorker('/mcp/tools')).toBe(false);
    expect(isMcpPathHandledInWorker('/.well-known/mcp-config')).toBe(false);
    expect(isMcpPathHandledInWorker('/api/mcp/handler')).toBe(false);
    expect(isMcpPathHandledInWorker('/api/bootstrap')).toBe(false);
  });
});

describe('worker fetch: MCP routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards: every one of these fell through to the
  // UPSTREAM_API_ORIGIN proxy, whose host does not resolve, so an MCP client
  // pointed at this site got a 530 instead of a tool list.
  test.each([...MCP_ROUTE_PATHS])('%s answers from the Worker, not the Vercel proxy', async (path) => {
    const seen: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      return new Response('upstream:proxied', { status: 200 });
    }) as typeof fetch;
    try {
      const req = new Request(`https://worldmonitor.sibt.ai${path}`, { method: 'POST' });
      const res = await worker.fetch(req, envWith());
      expect(await res.text()).toBe('in-worker-mcp');
      expect(handleMcpRpc).toHaveBeenCalledTimes(1);
      expect(seen.some((url) => url.includes('vercel-origin.worldmonitor.app'))).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
