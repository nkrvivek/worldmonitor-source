# World Monitor MCP Server

Last updated: July 7, 2026

The World Monitor MCP Server exposes World Monitor's real-time global-intelligence stack over the [Model Context Protocol](https://modelcontextprotocol.io), so any MCP-compatible client — Claude Desktop, Claude web, Cursor, MCP Inspector, or a custom agent — can pull live conflict, market, aviation, maritime, economic, cyber, and forecasting data directly into a model's context. It is the recommended way for AI agents to consume World Monitor data.

## Endpoint

- **Server URL:** `https://worldmonitor.sibt.ai/mcp` — Streamable HTTP transport, JSON-RPC 2.0 (JSON responses by default, SSE when the client advertises `text/event-stream`; `initialize` defaults to protocol `2025-03-26`).
- **Server card:** https://worldmonitor.sibt.ai/.well-known/mcp/server-card.json

## Tools

The server ships **59 tools** covering world and country briefs, country risk and resilience, China decision signals, conflict events, markets, commodities, global procurement opportunities, energy, maritime and aviation activity, cyber threats, sanctions, natural disasters, health signals, prediction markets, and AI forecasts. Issue `tools/list` for the live inventory, `prompts/list` for pre-built workflow templates, and `resources/list` for read-only resources. `tools/list`, `prompts/list`, and `resources/list` are **public** — no key required. Every tool accepts an optional `jmespath` argument for [server-side projection](https://worldmonitor.sibt.ai/docs/mcp-jmespath), typically an 80–95% response-size cut.

## MCP Apps

World Monitor supports MCP Apps (`io.modelcontextprotocol/ui`) with ten interactive `ui://` app shells. The linked tools are `get_country_risk`, `get_world_brief`, `get_country_brief`, `get_market_data`, `get_chokepoint_status`, `get_news_intelligence`, `get_conflict_events`, `get_natural_disasters`, `get_prediction_markets`, and `get_forecast_predictions`; their UI resources are:

- `ui://worldmonitor/country-risk.html`
- `ui://worldmonitor/world-brief.html`
- `ui://worldmonitor/country-brief.html`
- `ui://worldmonitor/market-radar.html`
- `ui://worldmonitor/chokepoint-monitor.html`
- `ui://worldmonitor/news-intelligence.html`
- `ui://worldmonitor/conflict-events.html`
- `ui://worldmonitor/natural-disasters.html`
- `ui://worldmonitor/prediction-markets.html`
- `ui://worldmonitor/forecasts.html`

Hosts discover the links through `_meta.ui.resourceUri` in `tools/list`, enumerate the shells through `resources/list`, and fetch each template with `resources/read`. `ui://` reads are public and quota-exempt because they return static, data-free HTML; live data still arrives through a normal authenticated `tools/call`. Full contract: [MCP Apps](https://worldmonitor.sibt.ai/docs/mcp-apps).

## Authentication

- **`tools/list` and other discovery calls:** anonymous, no key.
- **`tools/call` and `resources/read` (data):** need either an API key or OAuth.
  - **API key:** header `X-WorldMonitor-Key: wm_<40-hex>` — issue one at https://worldmonitor.sibt.ai/pro. Rate limit: 60 requests/minute/key.
  - **OAuth 2.1 (`scope=mcp`):** Pro and API tiers can both connect via OAuth with no API key. Dynamic Client Registration (RFC 7591) at `https://worldmonitor.sibt.ai/oauth/register`; authorization and token endpoints follow OAuth 2.1 with PKCE. Any OAuth-connected context — Pro *or* API tier — shares one 50 quota-consuming `tools/call` / `resources/read` counter per UTC day; API-tier clients that authenticate with a `wm_…` key instead have no daily reservation (only the 60 requests/minute limiter).

Full agent walkthrough: [auth.md](https://worldmonitor.sibt.ai/auth.md). Authorization-server metadata: https://worldmonitor.sibt.ai/.well-known/oauth-authorization-server · protected-resource metadata: https://worldmonitor.sibt.ai/.well-known/oauth-protected-resource

## Connect in one step

```sh
# Confirm reachability with the public CLI (no key):
npx worldmonitor tools
```

Add the server to Claude Desktop / Cursor via their MCP settings using the URL `https://worldmonitor.sibt.ai/mcp`, or follow the [MCP Quickstart](https://worldmonitor.sibt.ai/docs/mcp-quickstart) for a five-minute path to a real tool call.

## Learn more

- [MCP Overview](https://worldmonitor.sibt.ai/docs/mcp-overview) — auth modes, plans, OAuth setup, full tool catalog
- [MCP Apps](https://worldmonitor.sibt.ai/docs/mcp-apps) — interactive `ui://` resources, host flow, view security, and drift checks
- [MCP Quickstart](https://worldmonitor.sibt.ai/docs/mcp-quickstart) · [Tool reference](https://worldmonitor.sibt.ai/docs/mcp-tools-reference) · [JMESPath projection](https://worldmonitor.sibt.ai/docs/mcp-jmespath) · [Error catalog](https://worldmonitor.sibt.ai/docs/mcp-error-catalog)
- [Developer Portal](https://worldmonitor.sibt.ai/developers.md) · [REST API OpenAPI spec](https://worldmonitor.sibt.ai/openapi.md) · [SDKs](https://worldmonitor.sibt.ai/sdks.md) · [agents.md](https://worldmonitor.sibt.ai/agents.md)

## Important query matches

- World Monitor MCP server
- World Monitor Model Context Protocol server
- Connect Claude to World Monitor
- Real-time geopolitical intelligence MCP server
- MCP server for markets, conflicts, and global risk data
