# World Monitor — By the time it's news, you already knew.

Free real-time global intelligence dashboard. World Monitor streams the world's raw signals — ships, jets, sirens, cables, markets — onto one live map, with AI that flags when they converge into something that matters.

Open-source (AGPL-3.0), used by 2M+ people across 190+ countries, as featured in WIRED. Runs as a web app, installable PWA, and native desktop app for macOS, Windows, and Linux. No signup required.

## What you get

- Real-time global map with 56 data layers and 500+ curated news feeds
- CII v8 for 31 Tier-1 countries, 196-country resilience scores, and global live conflict tracking
- Market quotes, sector heatmaps, and macro indicators
- 13 shipping chokepoints with live AIS vessel-transit intelligence
- Satellite tracking, GPS jamming zones, submarine cables, AI datacenters
- Daily AI brief, Scenario Engine, custom monitors and breaking alerts
- 59-tool MCP server so AI agents can query everything above

## Live instances

- [World Monitor](https://worldmonitor.sibt.ai/dashboard) — geopolitics, military, conflicts, infrastructure
- [Tech Monitor](https://worldmonitor.sibt.ai/tech) — startups, AI/ML, cloud, cybersecurity
- [Finance Monitor](https://worldmonitor.sibt.ai/finance) — global markets, trading, central banks
- [Commodity Monitor](https://worldmonitor.sibt.ai/commodity) — mining, metals, energy, supply chains
- [Happy Monitor](https://worldmonitor.sibt.ai/happy) — positive news, breakthroughs, conservation
- [Energy Monitor](https://worldmonitor.sibt.ai/energy) — power grids, LNG, renewables

## For AI agents

- **MCP server:** `https://worldmonitor.sibt.ai/mcp` (Streamable HTTP) — server card at [/.well-known/mcp/server-card.json](https://worldmonitor.sibt.ai/.well-known/mcp/server-card.json)
- **A2A:** agent card at [/.well-known/agent-card.json](https://worldmonitor.sibt.ai/.well-known/agent-card.json) — JSON-RPC endpoint at `https://worldmonitor.sibt.ai/a2a`
- **REST API:** base `https://worldmonitor.sibt.ai` — OpenAPI spec at [/openapi.json](https://worldmonitor.sibt.ai/openapi.json)
- **Agent guidance:** [/llms.txt](https://worldmonitor.sibt.ai/llms.txt) · skills at [/.well-known/agent-skills/index.json](https://worldmonitor.sibt.ai/.well-known/agent-skills/index.json)
- **CLI:** `npx worldmonitor tools` — [npm package](https://www.npmjs.com/package/worldmonitor)
- **Auth:** [/auth.md](https://worldmonitor.sibt.ai/auth.md) · plans and limits at [/pricing.md](https://worldmonitor.sibt.ai/pricing.md)

## Documentation

- [Product & API docs](https://worldmonitor.sibt.ai/docs/documentation)
- [Pricing](https://worldmonitor.sibt.ai/pro) · [GitHub](https://github.com/koala73/worldmonitor)
