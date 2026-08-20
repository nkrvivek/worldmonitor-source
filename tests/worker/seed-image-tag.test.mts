import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The seed container image is built by .github/workflows/seed-container-image.yml
 * and named by scripts/seed-image-tag.sh. wrangler.jsonc has to spell out the
 * same name, because wrangler sends a registry image to Cloudflare as the tag
 * string rather than a digest -- a config pointing at a tag nobody built
 * deploys, and then the container never starts.
 *
 * Nothing keeps the two in step by itself, so this test does.
 *
 * A GREEN RUN HERE PROVES NOTHING UNTIL THE EDIT IS STAGED. The script reads
 * the git index, so with an unstaged change to the build context it computes
 * the tag for the previous content -- which is the tag already in
 * wrangler.jsonc, so this test agrees with itself and passes. Measured on
 * 3d8e3a0f2: npm run test:worker was green locally with all 250 tests passing,
 * the commit went out with a stale pin, and CI failed this exact assertion at
 * the same SHA. Stage first, then run.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// The one account every worker here deploys to. Hardcoded rather than read from
// the environment: this test must fail on a laptop with no CLOUDFLARE_ACCOUNT_ID
// set, not skip.
const ACCOUNT_ID = '3e2617436093fffd3446428537e90efd';

describe('the seed container image reference', () => {
  it('names the tag scripts/seed-image-tag.sh computes', () => {
    // Arrange
    const tag = execFileSync('./scripts/seed-image-tag.sh', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const raw = readFileSync(`${REPO_ROOT}wrangler.jsonc`, 'utf8');
    // Strip // comments so JSON.parse accepts the JSONC file.
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));

    // Act
    const image = config.containers[0].image;

    // Assert
    expect(image).toBe(
      `registry.cloudflare.com/${ACCOUNT_ID}/worldmonitor-seeds:${tag}`,
    );
  });

  it('is a registry reference, so no deploy needs a local Docker daemon', () => {
    // Arrange
    const raw = readFileSync(`${REPO_ROOT}wrangler.jsonc`, 'utf8');
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));

    // Act
    const image: string = config.containers[0].image;

    // Assert
    expect(image.startsWith('registry.cloudflare.com/')).toBe(true);
    // wrangler rejects this tag outright, and it would hide content changes
    // from the API even if it did not.
    expect(image.endsWith(':latest')).toBe(false);
  });
});
