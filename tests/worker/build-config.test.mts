import { describe, expect, test } from 'vitest';
import { resolveBuildHash } from '../../worker/build-hash';

describe('resolveBuildHash', () => {
  test('prefers the Workers Builds sha', () => {
    expect(
      resolveBuildHash({
        WORKERS_CI_COMMIT_SHA: 'workers-sha',
        CF_PAGES_COMMIT_SHA: 'pages-sha',
        VERCEL_GIT_COMMIT_SHA: 'vercel-sha',
      }),
    ).toBe('workers-sha');
  });

  test('falls back to the Pages sha', () => {
    expect(
      resolveBuildHash({
        CF_PAGES_COMMIT_SHA: 'pages-sha',
        VERCEL_GIT_COMMIT_SHA: 'vercel-sha',
      }),
    ).toBe('pages-sha');
  });

  test('still honours Vercel while the old deployment builds', () => {
    expect(resolveBuildHash({ VERCEL_GIT_COMMIT_SHA: 'vercel-sha' })).toBe('vercel-sha');
  });

  test('falls back to dev locally', () => {
    expect(resolveBuildHash({})).toBe('dev');
  });

  test('ignores an empty string rather than stamping it', () => {
    expect(resolveBuildHash({ WORKERS_CI_COMMIT_SHA: '' })).toBe('dev');
  });
});
