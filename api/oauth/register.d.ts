// Declarations for api/oauth/register.js — Dynamic Client Registration.
//
// The .js file has no `allowJs` under any tsconfig here, so a TypeScript
// importer gets an implicit `any` and tsconfig.worker.json fails on it.
// worker/routes/oauth.ts imports the default handler; api/internal/
// mcp-grant-mint.ts imports isAllowedRedirectUri to re-check a registered
// client's redirect URIs against the same allowlist.

export declare const config: { runtime: string };

/** True when `uri` is on the DCR allowlist, or is http on localhost/127.0.0.1. */
export declare function isAllowedRedirectUri(uri: string): boolean;

declare const handler: (req: Request) => Promise<Response>;
export default handler;
