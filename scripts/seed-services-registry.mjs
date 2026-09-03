/**
 * Shape rules for the seed-services registry.
 *
 * The registry file is still named scripts/railway-services.json because
 * seventeen files read it under that name — worker/seeds/registry.ts, the seed
 * bundle runners, and the tests that hold them in lockstep. The name is the
 * only thing about it that is still Railway: this fork runs the seeds as
 * Cloudflare cron triggers against the seed container, and the rows describe
 * what each seed runs and which files it depends on.
 *
 * This module used to be the front half of scripts/audit-railway-watch-paths.mjs,
 * which shelled out to the Railway CLI to reconcile that registry against a
 * live Railway project. There is no such project here, so the reconciling half
 * is gone. What is left is what still holds: the field validation, and the
 * predicate that picks out the rows carrying a dependency closure.
 */

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeDockerfilePath(value) {
  return typeof value === 'string' ? value.replace(/^\/+/, '') : '';
}

// deployMode is the registry's claim about where the build is rooted. It
// decides which build inputs and which shared-config prefix belong in a
// service's dependency closure, so a row that claims the wrong mode declares
// the wrong files and a change to a real dependency stops triggering a rebuild.
export const ROOT_DIRECTORY_BY_DEPLOY_MODE = Object.freeze({
  'nixpacks-root-scripts': 'scripts',
  'nixpacks-root-repo': '',
  dockerfile: '',
});

// The registry is hand-edited JSON with no runtime schema, so every field a
// caller derives behaviour from is validated here. A typo used to fail OPEN in
// two ways: an unknown deployMode made ROOT_DIRECTORY_BY_DEPLOY_MODE[...]
// undefined and skipped the rootDirectory check, and a non-array watchPatterns
// collapsed to [] and compared clean against a whole-repo filter — while the
// closure contract test skipped the same entry for `Array.isArray`. Both shapes
// reported a clean audit.
function assertRegistryEntry(entry) {
  const name = entry?.service ?? JSON.stringify(entry);
  if (hasOwn(entry, 'lifecycle') && !['active', 'planned'].includes(entry.lifecycle)) {
    throw new Error(
      `${name} declares unknown lifecycle ${JSON.stringify(entry.lifecycle)}; expected active or planned`,
    );
  }
  if (hasOwn(entry, 'deployMode') && !hasOwn(ROOT_DIRECTORY_BY_DEPLOY_MODE, entry.deployMode)) {
    throw new Error(
      `${name} declares unknown deployMode ${JSON.stringify(entry.deployMode)}; expected one of ${Object.keys(ROOT_DIRECTORY_BY_DEPLOY_MODE).join(', ')}`,
    );
  }
  if (hasOwn(entry, 'dockerfile')
    && (typeof entry.dockerfile !== 'string' || normalizeDockerfilePath(entry.dockerfile).length === 0)) {
    throw new Error(`${name} dockerfile must be a non-empty string`);
  }
  if (entry.deployMode === 'dockerfile' && !hasOwn(entry, 'dockerfile')) {
    throw new Error(`${name} deployMode dockerfile requires a dockerfile path`);
  }
  if (hasOwn(entry, 'watchPatterns')) {
    if (!Array.isArray(entry.watchPatterns)
      || entry.watchPatterns.some((pattern) => typeof pattern !== 'string')) {
      throw new Error(`${name} watchPatterns must be an array of strings`);
    }
  }
  if (hasOwn(entry, 'cronSchedule')
    && entry.cronSchedule !== null
    && typeof entry.cronSchedule !== 'string') {
    throw new Error(`${name} cronSchedule must be a string or null`);
  }
  if (hasOwn(entry, 'requiredEnv')) {
    if (!Array.isArray(entry.requiredEnv)) {
      throw new Error(`${name} requiredEnv must be an array`);
    }
    for (const requirement of entry.requiredEnv) {
      const alternatives = Array.isArray(requirement) ? requirement : [requirement];
      if (alternatives.length === 0) {
        throw new Error(`${name} requiredEnv contains an empty any-of group`);
      }
      for (const variable of alternatives) {
        if (typeof variable !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(variable)) {
          throw new Error(`${name} has invalid requiredEnv name ${JSON.stringify(variable)}`);
        }
      }
    }
  }
  return entry;
}

/**
 * The rows that carry a dependency closure or a schedule, with every row in the
 * registry validated on the way past.
 *
 * Planned rows stay in the registry so their Dockerfile and source coverage is
 * checked before anyone provisions them, but they describe a service that does
 * not run yet, so they are excluded until an explicit lifecycle activation.
 */
export function managedSeedServices(registry) {
  if (!Array.isArray(registry)) {
    throw new Error('seed service registry must be an array');
  }
  registry.forEach(assertRegistryEntry);
  return registry.filter(
    (entry) => entry.lifecycle !== 'planned'
      && (
        hasOwn(entry, 'watchPatterns')
        || (hasOwn(entry, 'cronSchedule') && entry.cronSchedule !== null)
      ),
  );
}
