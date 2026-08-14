# World Monitor — Agent Guide

> How AI agents should work with worldmonitor.sibt.ai: machine surfaces, authentication, crawl policy, rate limits, and discovery endpoints. Prefer the structured surfaces below over scraping the HTML dashboard — the dashboard is a WebGL SPA and yields nothing useful to a text parser.

World Monitor is a real-time global intelligence dashboard: 500+ news feeds, 56 map layer types, country risk/resilience scores, AI briefs, forecasts, and market/supply-chain correlation, served as machine-readable JSON with documented methodology and provenance.

## Machine surfaces (use these)

- **MCP server (recommended):** `https://worldmonitor.sibt.ai/mcp` — Streamable HTTP, 59 tools; issue `tools/list` for the live inventory. Server card: https://worldmonitor.sibt.ai/.well-known/mcp/server-card.json
- **REST API:** base `https://worldmonitor.sibt.ai` — OpenAPI spec: https://worldmonitor.sibt.ai/openapi.yaml (JSON: /openapi.json) · API catalog: https://worldmonitor.sibt.ai/.well-known/api-catalog
- **NLWeb:** `POST https://worldmonitor.sibt.ai/ask` (supports SSE) for natural-language questions; machine-readable dashboard view at `https://worldmonitor.sibt.ai/?mode=agent`
- **Agent Skills:** discovery index at https://worldmonitor.sibt.ai/.well-known/agent-skills/index.json · install via `npx skills add koala73/worldmonitor` (https://skills.sh/koala73/worldmonitor)
- **CLI:** `npx worldmonitor tools` lists every tool (public, no key) — https://www.npmjs.com/package/worldmonitor
- **SDKs:** Python `pip install worldmonitor-sdk` · Ruby `gem install worldmonitor` · Go `go get github.com/koala73/worldmonitor/sdk/go` · JavaScript npm `worldmonitor` — guide: https://worldmonitor.sibt.ai/docs/sdks
- **Sandbox / test environment:** https://worldmonitor.sibt.ai/sandbox/index.json — deterministic, schema-valid sample responses for representative REST operations; no auth, no quota, safe for CI. Guide: https://worldmonitor.sibt.ai/docs/sandbox
- **LLM briefings:** https://worldmonitor.sibt.ai/llms.txt (overview) · https://worldmonitor.sibt.ai/llms-full.txt (full reference) · section files: https://worldmonitor.sibt.ai/api/llms.txt (API) · https://worldmonitor.sibt.ai/docs/llms.txt (docs) · https://worldmonitor.sibt.ai/developers/llms.txt (developer portal) · https://worldmonitor.sibt.ai/blog/llms.txt (blog)
- **Schema map:** https://worldmonitor.sibt.ai/schemamap.xml — NLWeb schemamap indexing the structured-data surfaces
- **Research reports:** https://worldmonitor.sibt.ai/research/ — original source-backed research with downloadable CSV/JSON data, per-figure provenance, and stable citation URLs (no auth, no JavaScript required)
- **Developer portal:** https://worldmonitor.sibt.ai/developers.md — links every developer resource by name. Named resource pages: [MCP Server](https://worldmonitor.sibt.ai/mcp-server.md) · [OpenAPI Specification](https://worldmonitor.sibt.ai/openapi.md) · [SDKs](https://worldmonitor.sibt.ai/sdks.md)

## Authentication

- **Anonymous** works for discovery endpoints, `tools/list`, and public data (world brief, product catalog, story pages).
- **API key:** header `X-WorldMonitor-Key: wm_<40-hex>` for REST and MCP data calls — issue one at https://worldmonitor.sibt.ai/pro. Full agent walkthrough: https://worldmonitor.sibt.ai/auth.md
- **OAuth2** for MCP (`scope=mcp`), with dynamic client registration at `/oauth/register`. Details in auth.md.

## Crawl & content-usage policy

- **robots.txt** (https://worldmonitor.sibt.ai/robots.txt): AI search/assistant agents (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, DuckAssistBot, MistralAI-User) are explicitly allowed; bulk training-only scrapers (CCBot, Bytespider, anthropic-ai) are disallowed. `/api/` is off-limits to crawlers except the allowlisted story/OG/llms.txt/product-catalog routes.
- **Content-Signal:** `ai-train=no, search=yes, ai-input=yes` — declared as a robots.txt group directive and as an origin-wide HTTP response header. Search indexing and assistant grounding/citation are welcome; bulk model training is opted out.
- **User-Agent:** always send a descriptive `User-Agent` (e.g. `mytool/1.0 (+https://yoursite.example)`). Default HTTP-library UAs (`curl/*`, `python-requests/*`, empty strings) may get a 403 from the edge firewall — a 403 does NOT mean the endpoint is missing; retry with a real UA.

## Rate limits & plans

- Machine-readable pricing and plan limits: https://worldmonitor.sibt.ai/pricing.md · live JSON catalog: `GET https://worldmonitor.sibt.ai/api/product-catalog` (public, no key)
- Rate-limit documentation: https://worldmonitor.sibt.ai/docs/usage-rate-limits.md · auth matrix: https://worldmonitor.sibt.ai/docs/usage-auth
- Plan-limit responses include upgrade guidance; back off on 429 and honor `Retry-After`.

## Support & escalation

- https://worldmonitor.sibt.ai/support.md — hello@sibt.ai (general) · hello@sibt.ai (sales)
- Issues: https://github.com/koala73/worldmonitor/issues
- Source (AGPL-3.0): https://github.com/koala73/worldmonitor
