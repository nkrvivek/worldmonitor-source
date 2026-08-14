import { describe, it, expect } from 'vitest';
import { handleScheduled } from '../../worker/seeds/scheduled';

describe('handleScheduled', () => {
  it('starts one seed per script for the fired cron', async () => {
    const started: string[] = [];
    await handleScheduled({ cron: '*/15 * * * *' }, async (s) => {
      started.push(s);
    });

    expect(started).toEqual([
      'scripts/seed-conflict-intel.mjs',
      'scripts/seed-gdelt-bulk-materializer.mjs',
      'scripts/seed-shipping-stress.mjs',
      'scripts/seed-warm-ping.mjs',
    ]);
  });

  it('starts nothing for an unregistered cron expression', async () => {
    const started: string[] = [];
    await handleScheduled({ cron: '* * * * *' }, async (s) => {
      started.push(s);
    });

    expect(started).toEqual([]);
  });

  it('still starts the second seed when the first one throws', async () => {
    const started: string[] = [];
    await handleScheduled({ cron: '*/5 * * * *' }, async (s) => {
      started.push(s);
      if (s.endsWith('derived-signals.mjs')) throw new Error('boom');
    });

    expect(started).toHaveLength(2);
  });
});
