# Support & Contact - World Monitor

Last updated: July 5, 2026

How to reach World Monitor, by concern. Human-readable version: https://worldmonitor.sibt.ai/docs/support

## Channels

| Concern | Channel | Notes |
| --- | --- | --- |
| General support, account or billing issues | hello@sibt.ai | Primary support channel for all plans |
| Enterprise, sales, custom quotas | hello@sibt.ai | Custom pricing, deployments, higher API limits |
| Bug reports & feature requests | hello@sibt.ai | Include request IDs and the endpoint you called |
| In-app contact form | Form on https://worldmonitor.sibt.ai/pro | Submits `POST /api/leads/v1/submit-contact`; Turnstile-protected, intended for humans in a browser — agents should email hello@sibt.ai instead |

## Response Expectations

- Free and Pro: best-effort support by email. No formal SLA.
- API: best-effort support via email; include your key prefix (never the full key) and request IDs.
- Enterprise: dedicated support with committed response times, agreed per contract — contact hello@sibt.ai.

## Common Self-Serve Answers

- Find, create, or replace a `wm_` key: https://worldmonitor.sibt.ai/docs/api-keys. Full keys are shown only once and cannot be recovered; revoke a lost key and create a replacement.
- API key rotation or limit increases: see https://worldmonitor.sibt.ai/docs/usage-auth and https://worldmonitor.sibt.ai/docs/usage-rate-limits, or email hello@sibt.ai.
- Pricing and plans: https://worldmonitor.sibt.ai/pricing.md (markdown) or `GET https://worldmonitor.sibt.ai/api/product-catalog` (JSON, public).
- Billing portal (invoices, cancel/renew): sign in at https://worldmonitor.sibt.ai/pro and open the customer portal.
- Security reports: see https://worldmonitor.sibt.ai/.well-known/security.txt

## Machine-Readable Summary

```json
{
  "product": "World Monitor",
  "support_email": "hello@sibt.ai",
  "enterprise_email": "hello@sibt.ai",
  "security_txt": "https://worldmonitor.sibt.ai/.well-known/security.txt",
  "sla": { "free": "best-effort", "pro": "best-effort", "api": "best-effort", "enterprise": "contracted" }
}
```
