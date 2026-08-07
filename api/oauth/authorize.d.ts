// Declarations for api/oauth/authorize.js — the OAuth consent endpoint.
//
// Same reason as register.d.ts: the .js file is imported from TypeScript
// (worker/routes/oauth.ts) and would otherwise be an implicit `any`.

import type { FirstPartyOrigins } from '../_first-party-origin.ts';

export declare const config: { runtime: string };

/**
 * Renders the consent page. Only `client_name` and `redirect_uri` are read;
 * the handler passes the whole parsed query object through.
 */
export declare function consentPage(
  params: { client_name: string; redirect_uri: string },
  nonce: string,
  errorMsg?: string,
  origins?: FirstPartyOrigins,
): Response;

declare const handler: (req: Request) => Promise<Response>;
export default handler;
