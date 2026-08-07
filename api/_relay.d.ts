// Types for the JS module next door. worker/index.ts and
// tests/worker/api-relay-override.test.mts import it from TypeScript, and
// tsconfig.worker.json has no allowJs, so without this file both fail with
// TS7016. The other .js imports in worker/ carry `@ts-expect-error` instead;
// this one is typed because the fetcher worker/index.ts installs has a shape
// worth checking.

export type RelayFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Pass null to restore the plain network fetch. Tests rely on that. */
export declare function setRelayFetch(impl: RelayFetch | null): void;

export declare function relayFetch(url: string, init: RequestInit): Promise<Response>;

export declare function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs?: number,
): Promise<Response>;

export declare function getRelayBaseUrl(): string | null;

export declare function getRelayHeaders(
  baseHeaders?: Record<string, string>,
): Record<string, string>;

export declare function buildRelayResponse(
  response: Response,
  body: BodyInit | null,
  headers: Record<string, string>,
): Response;

// createRelayHandler's config carries per-endpoint callbacks whose shapes vary
// by handler. Only .js files call it, so the declaration stays loose rather
// than inventing a contract nothing checks.
export declare function createRelayHandler(
  cfg: Record<string, unknown>,
): (request: Request) => Promise<Response>;
