import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Measured 2026-08-13, chasing why the world brief kept falling back after the
// proper-noun gate was fixed. OpenRouter picks a different upstream per call,
// and the spread is bimodal rather than noisy:
//
//   SiliconFlow   4265ms      GMICloud      4618ms
//   Novita        2865ms      DigitalOcean 24042ms
//   (an earlier cold call)   46937ms
//
// The prompt is 1881 chars and the completion ~300 tokens every time, so the
// variance is routing, not work. At a 20s cap the slow upstreams were cut off
// and the run fell through to groq, whose lead ("War raises fears over food
// prices") names no entity and is correctly rejected by the anchor gate. The
// visible symptom was a fallback brief; the cause was a timeout shorter than
// the job on a minority of routes.
//
// These read the source rather than importing, because LLM_PROVIDERS is
// module-private and exporting it purely for a test would widen the surface.

const SEED = readFileSync(new URL('../scripts/seed-insights.mjs', import.meta.url), 'utf8');

/** Every `timeout: N_000,` in the provider table, in declaration order. */
function providerTimeoutsMs() {
  const table = SEED.slice(SEED.indexOf('const LLM_PROVIDERS = ['), SEED.indexOf('// Bounded retry for the brief LLM call'));
  assert.ok(table.length > 0, 'could not locate the LLM_PROVIDERS table');
  return [...table.matchAll(/^\s*timeout:\s*([\d_]+),/gm)]
    .map((m) => Number.parseInt(m[1].replace(/_/g, ''), 10));
}

function constantMs(name) {
  const found = SEED.match(new RegExp(`^const ${name} = ([\\d_]+);`, 'm'));
  assert.ok(found, `${name} not found in seed-insights.mjs`);
  return Number.parseInt(found[1].replace(/_/g, ''), 10);
}

describe('insights LLM provider budget', () => {
  // The chain walks providers in order on one shared budget. If the per-provider
  // timeouts sum past what the run can spend, the last provider is handed a
  // signal of a few milliseconds and reports "aborted due to timeout" without
  // ever having been given a chance — a starved provider and a slow one log the
  // same sentence.
  it('lets every provider be tried within the run budget', () => {
    const total = providerTimeoutsMs().reduce((a, b) => a + b, 0);
    const usable = constantMs('INSIGHTS_LLM_CALL_BUDGET_MS') - constantMs('INSIGHTS_LLM_CALL_BUDGET_GUARD_MS');

    assert.ok(
      total <= usable,
      `provider timeouts sum to ${total}ms but only ${usable}ms is usable — the last provider would be starved`,
    );
  });

  // 24042ms was a real, successful call. A cap below the slow routes throws away
  // a good answer we had already paid for.
  it('gives openrouter longer than the slowest upstream that still answered', () => {
    const openrouter = SEED.slice(SEED.indexOf("name: 'openrouter'"), SEED.indexOf("name: 'groq'"));
    const timeout = Number.parseInt(openrouter.match(/timeout:\s*([\d_]+),/)[1].replace(/_/g, ''), 10);

    assert.ok(timeout >= 24_042, `openrouter timeout ${timeout}ms cuts off routes measured answering at 24042ms`);
  });

  // Asking for the fast upstream is cheaper than waiting for the slow one. This
  // is the half that reduces the variance rather than paying for it.
  it('asks openrouter to route on throughput', () => {
    const openrouter = SEED.slice(SEED.indexOf("name: 'openrouter'"), SEED.indexOf("name: 'groq'"));

    assert.match(openrouter, /sort:\s*'throughput'/);
  });
});
