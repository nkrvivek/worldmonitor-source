import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SEED_JOBS, scriptsForCron } from '../../worker/seeds/registry';

const scriptsDir = new URL('../../scripts/', import.meta.url);

describe('seed registry', () => {
  it('maps a cron expression to its scripts', () => {
    expect(scriptsForCron('0 */6 * * *')).toEqual([
      'scripts/seed-supply-chain-trade.mjs',
    ]);
  });

  it('returns both scripts for a shared cron expression', () => {
    expect(scriptsForCron('*/15 * * * *')).toEqual([
      'scripts/seed-conflict-intel.mjs',
      'scripts/seed-gdelt-bulk-materializer.mjs',
    ]);
  });

  it('returns an empty list for an unregistered cron expression', () => {
    expect(scriptsForCron('* * * * *')).toEqual([]);
  });

  it('gives every cron expression its own entry', () => {
    const crons = SEED_JOBS.map((j) => j.cron);
    expect(new Set(crons).size).toBe(crons.length);
  });

  it('starts each script from exactly one cron expression', () => {
    // Two triggers for one script would run it twice on every overlap.
    const scripts = SEED_JOBS.flatMap((j) => j.scripts);
    expect(new Set(scripts).size).toBe(scripts.length);
  });

  it('points every entry at a script that exists', () => {
    const present = new Set(readdirSync(scriptsDir));
    const missing = SEED_JOBS.flatMap((j) => j.scripts).filter(
      (s) => !present.has(s.replace('scripts/', '')),
    );

    expect(missing).toEqual([]);
  });

  it('never schedules a script its bundle already runs', () => {
    // A bundle spawns its own members. Giving a member a second trigger would
    // run it twice, and the bundle's per-slot interval gate cannot see the
    // extra run.
    const scheduled = new Set(
      SEED_JOBS.flatMap((j) => j.scripts).map((s) => s.replace('scripts/', '')),
    );
    const members = new Set<string>();

    for (const script of scheduled) {
      if (!script.startsWith('seed-bundle-')) continue;
      const src = readFileSync(new URL(script, scriptsDir), 'utf8');
      for (const m of src.matchAll(/\bscript:\s*'([^']+\.mjs)'/g)) {
        if (m[1]) members.add(m[1]);
      }
    }

    expect([...members].filter((m) => scheduled.has(m))).toEqual([]);
  });

  it('keeps every schedule Railway recorded', () => {
    // railway-services.json is a partial snapshot: nine cron services out of
    // the ~50 that ran, and it omits seed-earthquakes entirely. The rest of
    // the schedules come from docs/railway-seed-consolidation-runbook.md. So
    // this asserts the snapshot is a subset of the registry, not that the two
    // are equal.
    const raw = readFileSync(
      new URL('../../scripts/railway-services.json', import.meta.url),
      'utf8',
    );
    const services: Array<{ entry?: string; cronSchedule?: string }> =
      JSON.parse(raw);

    const expected = services
      .filter((s) => s.cronSchedule)
      .map((s) => `${s.cronSchedule}|${s.entry}`)
      .sort();

    const actual = new Set(
      SEED_JOBS.flatMap((j) => j.scripts.map((s) => `${j.cron}|${s}`)),
    );

    expect(expected.filter((e) => !actual.has(e))).toEqual([]);
  });

  it('registers every cron in wrangler.jsonc and nothing more', () => {
    const raw = readFileSync(
      new URL('../../wrangler.jsonc', import.meta.url),
      'utf8',
    );
    // Strip // comments so JSON.parse accepts the JSONC file.
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    const configured: string[] = config.triggers.crons;

    expect([...configured].sort()).toEqual(
      [...SEED_JOBS.map((j) => j.cron)].sort(),
    );
  });

  it('stays inside the container instance ceiling at peak overlap', () => {
    // One instance per script, so max_instances has to cover every script that
    // can fire in the same minute. This walks every minute of a day on which
    // the monthly, weekly, daily and interval expressions can all line up, and
    // takes the busiest.
    const raw = readFileSync(
      new URL('../../wrangler.jsonc', import.meta.url),
      'utf8',
    );
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    const ceiling: number = config.containers[0].max_instances;

    // Cloudflare rejects a numeric 0 for Sunday — `0 3 * * 0` came back as
    // "invalid cron string ... [code: 10100]" on a live deploy — so the weekly
    // entries name their day instead.
    const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

    const fires = (field: string, value: number) =>
      field === '*' ||
      field
        .split(',')
        .some((part) =>
          part.startsWith('*/')
            ? value % Number(part.slice(2)) === 0
            : DAYS.indexOf(part.toUpperCase()) === value ||
              Number(part) === value,
        );

    let peak = 0;
    // Day-of-month 1 is the busiest date; every weekday gets its own pass.
    for (let weekday = 0; weekday < 7; weekday++) {
      for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute++) {
          let running = 0;
          for (const job of SEED_JOBS) {
            const [min = '*', hr = '*', dom = '*', , dow = '*'] =
              job.cron.split(' ');
            if (
              fires(min, minute) &&
              fires(hr, hour) &&
              fires(dom, 1) &&
              fires(dow, weekday)
            ) {
              running += job.scripts.length;
            }
          }
          peak = Math.max(peak, running);
        }
      }
    }

    expect(peak).toBeLessThanOrEqual(ceiling);
  });
});
