# World Monitor OpenAPI Specification

Last updated: July 7, 2026

The World Monitor OpenAPI Specification is the machine-readable contract for the World Monitor REST API — the HTTP surface that exposes the same real-time global-intelligence tools and data as the [MCP server](https://worldmonitor.sibt.ai/mcp-server.md) via granular REST endpoints, returning source-attributed structured JSON. Point your OpenAPI client, code generator, or agent at the spec to discover every endpoint, parameter, and response shape.

## The spec

- **OpenAPI 3.1 (YAML):** https://worldmonitor.sibt.ai/openapi.yaml
- **OpenAPI 3.1 (JSON):** https://worldmonitor.sibt.ai/openapi.json
- **REST API base URL:** `https://worldmonitor.sibt.ai`
- **Served Content-Type:** `application/yaml; charset=utf-8` (YAML) and `application/json; charset=utf-8` (JSON), both with `Access-Control-Allow-Origin: *`. The API catalog advertises the OpenAPI descriptor media type `application/vnd.oai.openapi` for the spec.

The spec is generated on every deploy from the canonical proto/service definitions, so it always matches the running gateway — there is no hand-maintained drift.

## Related descriptors

- **Commerce / pricing endpoints** live in a separate spec (kept out of the root bundle for size): https://worldmonitor.sibt.ai/docs/openapi/CommerceService.openapi.yaml
- **API catalog (RFC 9727):** https://worldmonitor.sibt.ai/.well-known/api-catalog — a linkset that enumerates the REST API, MCP server, OpenAPI spec, pricing, support, and status surfaces.
- **Human documentation:** https://worldmonitor.sibt.ai/docs/documentation

## Authentication

Send the header `X-WorldMonitor-Key: wm_<40-hex>` on data calls (issue a key at https://worldmonitor.sibt.ai/pro); discovery routes are public. Always send a descriptive `User-Agent` — the edge firewall challenges generic library agents (`curl/*`, `python-requests/*`), and a 403 means "retry with a real UA", not "endpoint missing". Rate limit: 60 requests/minute/key; honor `Retry-After` on 429. Full matrix: https://worldmonitor.sibt.ai/docs/usage-auth · walkthrough: [auth.md](https://worldmonitor.sibt.ai/auth.md)

## Use it

```sh
# Generate a typed client from the spec:
npx @openapitools/openapi-generator-cli generate \
  -i https://worldmonitor.sibt.ai/openapi.yaml -g python -o ./wm-client
```

Or skip codegen entirely and use an [official SDK](https://worldmonitor.sibt.ai/sdks.md) or the [CLI](https://worldmonitor.sibt.ai/docs/cli).

## Learn more

- [Developer Portal](https://worldmonitor.sibt.ai/developers.md) · [MCP Server](https://worldmonitor.sibt.ai/mcp-server.md) · [SDKs](https://worldmonitor.sibt.ai/sdks.md) · [agents.md](https://worldmonitor.sibt.ai/agents.md) · [API llms.txt](https://worldmonitor.sibt.ai/api/llms.txt)

## Important query matches

- World Monitor OpenAPI specification
- World Monitor OpenAPI 3.1 spec
- World Monitor REST API OpenAPI YAML / JSON
- Generate a World Monitor API client from OpenAPI
- Global intelligence REST API spec
