import { describe, expect, test } from "vitest";

import {
  DEFAULT_SITE_URL,
  allowedReturnOrigins,
  resolveReturnUrl,
  resolveSiteUrl,
} from "../payments/returnUrl";

const SITE = "https://worldmonitor.sibt.ai";

describe("resolveSiteUrl", () => {
  test("prefers SITE_URL", () => {
    expect(resolveSiteUrl({ SITE_URL: "https://staging.example.com" })).toBe(
      "https://staging.example.com",
    );
  });

  // The old fallback was upstream's apex. On a deployment that forgot to set
  // SITE_URL, every checkout returned the paying customer to a site we do not
  // run — the same bug /a2a and /ask had.
  test("falls back to this fork, not upstream", () => {
    expect(resolveSiteUrl({})).toBe(DEFAULT_SITE_URL);
    expect(DEFAULT_SITE_URL).toBe(SITE);
  });
});

describe("allowedReturnOrigins", () => {
  test("trusts the site origin", () => {
    expect([...allowedReturnOrigins(SITE)]).toEqual([SITE]);
  });

  // Upstream listed its own apex plus seven subdomains here. This fork serves
  // one host and does not control any worldmonitor.app name, so trusting them
  // meant our checkout would hand a customer off to somebody else's site.
  test("does not trust upstream's hosts", () => {
    const origins = allowedReturnOrigins(SITE);
    expect(origins.has("https://worldmonitor.app")).toBe(false);
    expect(origins.has("https://tech.worldmonitor.app")).toBe(false);
  });

  test("adds extra origins from the env list, ignoring blanks", () => {
    const origins = allowedReturnOrigins(SITE, " https://a.example.com , ,https://b.example.com ");
    expect([...origins].sort()).toEqual([
      "https://a.example.com",
      "https://b.example.com",
      SITE,
    ]);
  });

  // A path or a trailing slash in the env list must not widen the set: the
  // check compares URL.origin, so anything else would silently never match.
  test("normalizes an extra entry to its origin", () => {
    expect(allowedReturnOrigins(SITE, "https://a.example.com/checkout").has("https://a.example.com")).toBe(
      true,
    );
  });

  test("drops an unparseable extra entry", () => {
    expect([...allowedReturnOrigins(SITE, "not a url")]).toEqual([SITE]);
  });
});

describe("resolveReturnUrl", () => {
  test("falls back to the site url when none is given", () => {
    expect(resolveReturnUrl(undefined, SITE)).toBe(SITE);
  });

  test("keeps a full url on a trusted origin, path and query intact", () => {
    expect(resolveReturnUrl(`${SITE}/pro?wm_checkout=return`, SITE)).toBe(
      `${SITE}/pro?wm_checkout=return`,
    );
  });

  test("rejects a relative url", () => {
    expect(() => resolveReturnUrl("/pro", SITE)).toThrow(/valid absolute URL/);
  });

  // The open-redirect this guard exists for.
  test("rejects an untrusted origin", () => {
    expect(() => resolveReturnUrl("https://evil.example.com/pro", SITE)).toThrow(/trusted origin/);
    expect(() => resolveReturnUrl("https://worldmonitor.app/pro", SITE)).toThrow(/trusted origin/);
  });

  test("rejects a lookalike host and a port on a trusted host", () => {
    expect(() => resolveReturnUrl("https://worldmonitor.sibt.ai.evil.com/", SITE)).toThrow(
      /trusted origin/,
    );
    expect(() => resolveReturnUrl("https://worldmonitor.sibt.ai:8443/", SITE)).toThrow(
      /trusted origin/,
    );
  });

  test("accepts an origin named in the env list", () => {
    expect(resolveReturnUrl("https://a.example.com/pro", SITE, "https://a.example.com")).toBe(
      "https://a.example.com/pro",
    );
  });
});
