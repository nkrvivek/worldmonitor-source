import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// The counter and rate-limit tests. The root vitest config only includes
// convex/ and server/, and the worker config only includes tests/worker/, so
// tests under tests/counters/ would match neither and silently never run.
//
// CounterDO (tests/counters/counter-do.test.mts) needs a real workerd to run
// against, which the plain node environment cannot give it — hence the
// cloudflareTest Vite plugin instead of a plain node environment.
// sliding-window.test.mts and daily-meter.test.mts are plain TypeScript with
// no Workers-specific APIs; they run fine inside this same pool, so one
// config still covers all of tests/counters/**.
//
// @cloudflare/vitest-pool-workers 0.20.1 dropped the `defineWorkersConfig` /
// `poolOptions.workers` shape (vitest v3 era) in favor of this
// plugin-based `cloudflareTest(...)` call inside a normal `defineConfig`
// (see the package's own dist/codemods/vitest-v3-to-v4.mjs, which rewrites
// old configs into exactly this shape) — 0.20.1 is the version whose peer
// dependency (vitest ^4.1.0) matches the vitest 4.1.1 already installed here.
export default defineConfig({
  test: {
    include: ['tests/counters/**/*.test.mts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
});
