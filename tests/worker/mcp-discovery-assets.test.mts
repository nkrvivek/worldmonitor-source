import { afterEach, describe, expect, test } from 'vitest';
import {
  setStaticAssetFetch,
  resetStaticAssetCaches,
} from '../../api/mcp/handler';
import mcpHandler from '../../api/mcp/handler';

/**
 * A crawler GET of /mcp and /.well-known/mcp answered 302 on this host, not
 * the discovery document. Measured 2026-08-06 against production:
 *
 *   GET /mcp             -> 302, location: /mcp-server.md
 *   GET /.well-known/mcp -> 302, location: /.well-known/mcp/server-card.json
 *
 * Both static files serve 200 at those URLs, so nothing was missing. The
 * handler reads them by fetching its own hostname, and a Worker fetching the
 * host it is serving is a subrequest loop that Cloudflare declines — the same
 * shape that put /api/opensky on 522 (docs/architecture/api-routing-gap.md).
 * The read failed, and the handler's own fallback turned that into a redirect.
 *
 * The reader is now swappable, the way relayFetch is, so worker/index.ts can
 * point it at the ASSETS binding instead of at the network.
 */

const GUIDE = '# WorldMonitor MCP\n\nStreamable HTTP at /mcp.\n';
const CARD = '{"name":"worldmonitor"}';

afterEach(() => {
  setStaticAssetFetch(null);
  resetStaticAssetCaches();
});

function crawlerGet(path: string): Request {
  return new Request(`https://worldmonitor.sibt.ai${path}`, {
    headers: { Accept: 'text/html,*/*' },
  });
}

function installReader(): string[] {
  const asked: string[] = [];
  setStaticAssetFetch(async (path: string) => {
    asked.push(path);
    if (path === '/mcp-server.md') return GUIDE;
    if (path === '/.well-known/mcp/server-card.json') return CARD;
    return null;
  });
  return asked;
}

describe('crawler discovery reads the static documents', () => {
  test('GET /mcp answers 200 with the guide, not a redirect', async () => {
    const asked = installReader();

    const response = await mcpHandler(crawlerGet('/mcp'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(GUIDE);
    expect(asked).toContain('/mcp-server.md');
  });

  test('GET /.well-known/mcp answers 200 with the server card, not a redirect', async () => {
    installReader();

    const response = await mcpHandler(crawlerGet('/.well-known/mcp'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CARD);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });

  /**
   * The redirect is still the right answer when the document genuinely cannot
   * be read — it points the fetcher at the canonical static path rather than
   * caching a failure. Losing that would trade one silent failure for another.
   */
  test('an unreadable document still falls back to the canonical path', async () => {
    setStaticAssetFetch(async () => null);

    const response = await mcpHandler(crawlerGet('/mcp'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/mcp-server.md');
  });

  test('a document is read once and served from memory after that', async () => {
    const asked = installReader();

    await mcpHandler(crawlerGet('/mcp'));
    await mcpHandler(crawlerGet('/mcp'));

    expect(asked.filter(path => path === '/mcp-server.md')).toHaveLength(1);
  });

  /**
   * Content negotiation on these URLs is what keeps a stored discovery body
   * from being replayed to a transport client. The reader swap must not touch
   * it.
   */
  test('an SSE stream-open still gets the transport 405', async () => {
    installReader();

    const response = await mcpHandler(
      new Request('https://worldmonitor.sibt.ai/mcp', {
        headers: { Accept: 'text/event-stream' },
      }),
    );

    expect(response.status).toBe(405);
  });
});
