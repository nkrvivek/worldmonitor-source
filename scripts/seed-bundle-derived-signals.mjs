#!/usr/bin/env node
import { runBundle, MIN, HOUR } from './_bundle-runner.mjs';
import { CHINA_DECISION_SIGNALS_KEY } from './seed-china-decision-signals.mjs';

await runBundle('derived-signals', [
  { label: 'Correlation', script: 'seed-correlation.mjs', seedMetaKey: 'correlation:cards', canonicalKey: 'correlation:cards-bootstrap:v1', intervalMs: 5 * MIN, timeoutMs: 60_000 },
  { label: 'Cross-Source-Signals', script: 'seed-cross-source-signals.mjs', seedMetaKey: 'intelligence:cross-source-signals', canonicalKey: 'intelligence:cross-source-signals:v1', intervalMs: 15 * MIN, timeoutMs: 120_000 },
  // Gate on the completion marker written only after the canonical archive,
  // compact bootstrap projection, and per-source health records all succeed.
  // A partial cohort therefore retries on the next bundle tick.
  // The section used to require JAPAN_MOD_PROXY_URL or PROXY_URL, sized for
  // Railway egress that Japan MoD blocked. This fork sets neither name
  // anywhere, so the gate reported CONFIG_ERROR every tick and the seed never
  // ran -- which is why all three cross-strait checks read EMPTY. Run direct on
  // 2026-08-05 it takes 21s and writes 21 records from both sources. The
  // completion marker above is the real guard: a cohort that loses a source
  // writes no marker and retries on the next tick, so a blocked egress costs a
  // retry rather than a partial publish.
  { label: 'Cross-Strait-Activity', script: 'seed-cross-strait-activity.mjs', seedMetaKey: 'military:cross-strait-activity:complete', intervalMs: 3 * HOUR, timeoutMs: 300_000 },
  { label: 'China-Decision-Signals', script: 'seed-china-decision-signals.mjs', seedMetaKey: 'intelligence:china-decision-signals', canonicalKey: CHINA_DECISION_SIGNALS_KEY, intervalMs: 15 * MIN, timeoutMs: 90_000 },
  { label: 'Regional-Snapshots', script: 'seed-regional-snapshots.mjs', seedMetaKey: 'intelligence:regional-snapshots', intervalMs: 6 * HOUR, timeoutMs: 180_000 },
], {
  // Railway kills cron containers at 10 minutes. Defer sections whose full
  // timeout plus SIGTERM/SIGKILL grace cannot fit, preserving completed work.
  maxBundleMs: 570_000,
});
