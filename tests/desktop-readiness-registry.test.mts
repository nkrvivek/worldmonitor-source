import { existsSync, globSync, readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DESKTOP_PARITY_FEATURES } from '../src/services/desktop-readiness';

/**
 * DESKTOP_PARITY_FEATURES names files and routes as plain strings, and nothing
 * checked them. The strategic-risk row still pointed at `/api/risk-scores` and
 * `api/risk-scores.js` long after that endpoint became the sebuf RPC
 * `/api/intelligence/v1/get-risk-scores` — the handler file had not existed for
 * some time, and the readiness report kept reporting on it.
 *
 * Route registries: the sebuf codegen writes one route table per service under
 * src/generated/server, and worker/routes/plain-api.ts holds the plain /api
 * ones. Between them they name every route a browser can reach here.
 *
 * Not server/gateway.ts: that file's `/api/...` keys are a cache-policy map,
 * and a real route may be absent from it — `/api/military/v1/
 * get-aircraft-details-batch` is, while its non-batch sibling is not.
 */
const ROUTE_REGISTRIES = [
  ...globSync('src/generated/server/**/*_server.ts'),
  'worker/routes/plain-api.ts',
];

test('every file DESKTOP_PARITY_FEATURES names is on disk', () => {
  const missing: string[] = [];
  for (const feature of DESKTOP_PARITY_FEATURES) {
    for (const path of [...feature.serviceFiles, ...feature.apiHandlers]) {
      if (!existsSync(path)) missing.push(`${feature.id}: ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every route DESKTOP_PARITY_FEATURES names is registered somewhere', () => {
  const registries = ROUTE_REGISTRIES.map(path => readFileSync(path, 'utf-8')).join('\n');
  const unregistered: string[] = [];
  for (const feature of DESKTOP_PARITY_FEATURES) {
    for (const route of feature.apiRoutes) {
      if (!registries.includes(route)) unregistered.push(`${feature.id}: ${route}`);
    }
  }
  assert.deepEqual(unregistered, []);
});
