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

describe('handleScheduled start failures', () => {
  it('reports every failed start to onStartError, naming script and error', async () => {
    const reported: { script: string; message: string }[] = [];
    await handleScheduled(
      { cron: '*/5 * * * *' },
      async (s) => {
        throw new Error(`boom ${s}`);
      },
      async (script, err) => {
        reported.push({ script, message: (err as Error).message });
      },
    );

    expect(reported).toHaveLength(2);
    const first = reported[0]!;
    expect(first.message).toBe(`boom ${first.script}`);
  });

  it('does not call onStartError for a seed that started', async () => {
    const reported: string[] = [];
    await handleScheduled(
      { cron: '*/5 * * * *' },
      async (s) => {
        if (s.endsWith('derived-signals.mjs')) throw new Error('boom');
      },
      async (script) => {
        reported.push(script);
      },
    );

    expect(reported).toEqual(['scripts/seed-bundle-derived-signals.mjs']);
  });

  it('still starts the siblings when onStartError itself throws', async () => {
    const started: string[] = [];
    await handleScheduled(
      { cron: '*/5 * * * *' },
      async (s) => {
        started.push(s);
        throw new Error('boom');
      },
      async () => {
        throw new Error('recording failed too');
      },
    );

    expect(started).toHaveLength(2);
  });
});
