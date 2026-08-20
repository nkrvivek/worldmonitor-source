# World Monitor Developer Portal

Last updated: July 7, 2026

The World Monitor Developer Portal is the single entry point for building on World Monitor — the real-time global-intelligence platform that correlates geopolitics, markets, commodities, shipping, aviation, infrastructure, cyber threats, weather, and live news as source-attributed structured JSON. Every developer surface below shares one authentication model and one tool inventory, so you can start with the MCP server and drop down to the REST API or an SDK without relearning anything.

This page names and links every developer resource type. For the machine-readable companion, see [agents.md](https://worldmonitor.sibt.ai/agents.md) and the [API llms.txt](https://worldmonitor.sibt.ai/api/llms.txt).

## Developer Resources

- **[World Monitor MCP Server](https://worldmonitor.sibt.ai/mcp-server.md):** the recommended agent surface — `https://worldmonitor.sibt.ai/mcp`, Streamable HTTP, 59 tools. Connect Claude, Cursor, and any MCP-compatible client to live intelligence data. Details: [mcp-server.md](https://worldmonitor.sibt.ai/mcp-server.md) · [MCP Overview](https://worldmonitor.sibt.ai/docs/mcp-overview) · Server card: https://worldmonitor.sibt.ai/.well-known/mcp/server-card.json
- **[World Monitor OpenAPI Specification](https://worldmonitor.sibt.ai/openapi.md):** the OpenAPI 3.1 contract for the REST API — [openapi.yaml](https://worldmonitor.sibt.ai/openapi.yaml) · [openapi.json](https://worldmonitor.sibt.ai/openapi.json). Details: [openapi.md](https://worldmonitor.sibt.ai/openapi.md)
- **World Monitor REST API:** base `https://worldmonitor.sibt.ai` — the same tools and data as the MCP server, exposed as granular endpoints over plain HTTP. Machine-readable [API catalog (RFC 9727)](https://worldmonitor.sibt.ai/.well-known/api-catalog) · human docs at [/docs/documentation](https://worldmonitor.sibt.ai/docs/documentation)
- **[World Monitor SDKs](https://worldmonitor.sibt.ai/sdks.md):** official zero-dependency client libraries for Python, Ruby, Go, and JavaScript. Details: [sdks.md](https://worldmonitor.sibt.ai/sdks.md) · [SDK guide](https://worldmonitor.sibt.ai/docs/sdks)
- **World Monitor CLI:** `npx worldmonitor tools` scripts every tool from a shell — [npm `worldmonitor`](https://www.npmjs.com/package/worldmonitor) · [CLI guide](https://worldmonitor.sibt.ai/docs/cli)
- **World Monitor Agent Skills:** installable skills for agent frameworks — discovery index at https://worldmonitor.sibt.ai/.well-known/agent-skills/index.json · `npx skills add koala73/worldmonitor`
- **World Monitor API documentation:** the full developer documentation site at [/docs](https://worldmonitor.sibt.ai/docs/documentation), including the [MCP Quickstart](https://worldmonitor.sibt.ai/docs/mcp-quickstart), [tool reference](https://worldmonitor.sibt.ai/docs/mcp-tools-reference), and [JMESPath projection guide](https://worldmonitor.sibt.ai/docs/mcp-jmespath).
- **World Monitor authentication:** the agent auth walkthrough at [auth.md](https://worldmonitor.sibt.ai/auth.md) — API keys (`X-WorldMonitor-Key: wm_<40-hex>`) and OAuth 2.1 (`scope=mcp`) with dynamic client registration.
- **World Monitor sandbox:** deterministic, schema-valid sample responses for representative REST operations — no key, no quota, safe for CI. Index: https://worldmonitor.sibt.ai/sandbox/index.json · [Sandbox guide](https://worldmonitor.sibt.ai/docs/sandbox) · scoped context: [developers/llms.txt](https://worldmonitor.sibt.ai/developers/llms.txt)

## Authentication in one line

Discovery endpoints and `tools/list` are public. Data calls need either an API key header `X-WorldMonitor-Key: wm_<40-hex>` (issue one at https://worldmonitor.sibt.ai/pro) or OAuth 2.1 with scope `mcp`. The full walkthrough — including dynamic client registration and the Pro sign-in flow — lives at [auth.md](https://worldmonitor.sibt.ai/auth.md).

## Pricing, limits & support

- **Pricing and plan limits:** [pricing.md](https://worldmonitor.sibt.ai/pricing.md) · live JSON catalog `GET https://worldmonitor.sibt.ai/api/product-catalog`
- **Rate limits:** 60 requests/minute (per key, or per user for OAuth); any OAuth-connected context (Pro *or* API tier) also shares one 50 quota-consuming MCP calls/UTC day counter, while `wm_…`-key MCP clients have no daily reservation. Honor `Retry-After` on 429.
- **Support:** [support.md](https://worldmonitor.sibt.ai/support.md) — hello@sibt.ai
- **Source (AGPL-3.0):** https://github.com/koala73/worldmonitor · Issues: https://github.com/koala73/worldmonitor/issues

## Important query matches

- World Monitor developer portal
- World Monitor API for developers
- Build on World Monitor
- World Monitor MCP server, OpenAPI, SDK, and CLI
- How to access World Monitor data programmatically
