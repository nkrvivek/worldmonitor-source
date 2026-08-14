import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// The AIS relay tests. The root config includes only convex/ and server/, the
// worker config only tests/worker/, and the counters config only
// tests/counters/ — so tests under tests/ais-relay/ would match none of them
// and silently never run.
//
// AisRelayDO needs a real workerd to run against (Durable Object storage, the
// alarm, outbound WebSocket), which the plain node environment cannot give it;
// hence cloudflareTest rather than a node environment. The pure modules
// (backoff, auth, vessel-state) have no Workers-specific APIs and run fine in
// the same pool, so one config covers all of tests/ais-relay/**.
//
// Same plugin shape as vitest.counters.config.mts — see that file for why
// @cloudflare/vitest-pool-workers 0.20.1 uses cloudflareTest(...) inside a
// normal defineConfig rather than the older defineWorkersConfig.
export default defineConfig({
  test: {
    include: ['tests/ais-relay/**/*.test.mts'],
    // Headroom over the 5s default for a cold workerd pool on a loaded
    // machine, and still short enough that a real hang fails the suite
    // rather than stalling CI. It is not network headroom — see the empty
    // AISSTREAM_API_KEY binding below, which keeps this suite off the
    // internet.
    testTimeout: 10_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Forced empty, and it must stay that way. Wrangler loads .env.local
        // into the test environment, so once a developer sets a real
        // AISSTREAM_API_KEY there, connectUpstream() stops throwing early and
        // starts dialling stream.aisstream.io for real: three tests then fail,
        // two of them by timeout, on a machine where nothing is wrong.
        // Measured 2026-08-04. An empty string is falsy, so connectUpstream()
        // throws before the fetch exactly as it did when the name was unset.
        bindings: { AISSTREAM_API_KEY: '' },
      },
    }),
  ],
});
