import { describe, expect, it } from 'vitest';
import { SEED_JOBS } from '../../worker/seeds/registry';
import { MAX_WINDOW_MINUTES, cronMatches, dueScripts } from '../../worker/seeds/due';

/** UTC epoch ms — Cloudflare schedules crons in UTC and so does this matcher. */
const at = (iso: string) => Date.parse(`${iso}Z`);

describe('cronMatches', () => {
  it('matches a step field on its multiples and nothing between', () => {
    expect(cronMatches('*/5 * * * *', at('2026-08-07T14:05:00'))).toBe(true);
    expect(cronMatches('*/5 * * * *', at('2026-08-07T14:00:00'))).toBe(true);
    expect(cronMatches('*/5 * * * *', at('2026-08-07T14:07:00'))).toBe(false);
  });

  it('matches every minute in a list, and only those', () => {
    expect(cronMatches('11,41 * * * *', at('2026-08-07T09:11:00'))).toBe(true);
    expect(cronMatches('11,41 * * * *', at('2026-08-07T09:41:00'))).toBe(true);
    expect(cronMatches('11,41 * * * *', at('2026-08-07T09:40:00'))).toBe(false);
  });

  it('steps the hour field independently of the minute', () => {
    expect(cronMatches('15 */3 * * *', at('2026-08-07T03:15:00'))).toBe(true);
    expect(cronMatches('15 */3 * * *', at('2026-08-07T04:15:00'))).toBe(false);
    expect(cronMatches('15 */3 * * *', at('2026-08-07T03:16:00'))).toBe(false);
  });

  it('reads day names, not just numbers', () => {
    // 2026-08-09 is a Sunday; 2026-08-10 a Monday.
    expect(cronMatches('0 3 * * SUN', at('2026-08-09T03:00:00'))).toBe(true);
    expect(cronMatches('0 3 * * SUN', at('2026-08-10T03:00:00'))).toBe(false);
    expect(cronMatches('0 3 * * 0', at('2026-08-09T03:00:00'))).toBe(true);
  });

  it('matches a day of the month', () => {
    expect(cronMatches('0 4 1 * *', at('2026-09-01T04:00:00'))).toBe(true);
    expect(cronMatches('0 4 1 * *', at('2026-09-02T04:00:00'))).toBe(false);
  });

  it('matches a range', () => {
    expect(cronMatches('0 0 * * 1-5', at('2026-08-07T00:00:00'))).toBe(true); // Friday
    expect(cronMatches('0 0 * * 1-5', at('2026-08-08T00:00:00'))).toBe(false); // Saturday
  });

  it('ORs day-of-month against day-of-week when both are restricted', () => {
    // Standard cron: with both fields restricted a match on either fires.
    // 2026-08-09 is a Sunday and not the 1st; the 1st of August is a Saturday.
    expect(cronMatches('0 0 1 * SUN', at('2026-08-09T00:00:00'))).toBe(true);
    expect(cronMatches('0 0 1 * SUN', at('2026-08-01T00:00:00'))).toBe(true);
    expect(cronMatches('0 0 1 * SUN', at('2026-08-04T00:00:00'))).toBe(false);
  });

  it('refuses an expression it cannot read rather than never matching', () => {
    // A silent false here is the worst outcome available: the seed stops
    // running and the run reports a clean pass.
    expect(() => cronMatches('*/5 * * *', at('2026-08-07T14:05:00'))).toThrow(/5 fields/);
    expect(() => cronMatches('*/5 * * * FUNDAY', at('2026-08-07T14:05:00'))).toThrow(/FUNDAY/);
    expect(() => cronMatches('99 * * * *', at('2026-08-07T14:05:00'))).toThrow(/99/);
  });
});

describe('dueScripts', () => {
  const jobs = [
    { cron: '*/5 * * * *', scripts: ['scripts/a.mjs', 'scripts/b.mjs'] },
    { cron: '0 * * * *', scripts: ['scripts/b.mjs', 'scripts/c.mjs'] },
    { cron: '0 4 1 * *', scripts: ['scripts/monthly.mjs'] },
  ];

  it('returns the scripts whose cron fell inside the window', () => {
    const from = at('2026-08-07T14:00:00');
    const to = at('2026-08-07T14:06:00');
    expect(dueScripts(from, to, jobs)).toEqual(['scripts/a.mjs', 'scripts/b.mjs']);
  });

  it('treats the start of the window as exclusive and the end as inclusive', () => {
    // 14:00:00 exactly. Exclusive start: the hourly job that fired at 14:00
    // belongs to the previous run, not this one.
    const justAfter = dueScripts(at('2026-08-07T14:00:00'), at('2026-08-07T14:04:00'), jobs);
    expect(justAfter).toEqual([]);
    const including = dueScripts(at('2026-08-07T13:59:00'), at('2026-08-07T14:00:00'), jobs);
    expect(including).toEqual(['scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs']);
  });

  it('names each script once even when several jobs ask for it', () => {
    const all = dueScripts(at('2026-08-07T13:59:00'), at('2026-08-07T14:00:00'), jobs);
    expect(all.filter((s) => s === 'scripts/b.mjs')).toHaveLength(1);
  });

  it('returns nothing when the window is empty or inverted', () => {
    expect(dueScripts(at('2026-08-07T14:00:00'), at('2026-08-07T14:00:00'), jobs)).toEqual([]);
    expect(dueScripts(at('2026-08-07T15:00:00'), at('2026-08-07T14:00:00'), jobs)).toEqual([]);
  });

  it('refuses a window longer than the cap', () => {
    const from = at('2026-08-01T00:00:00');
    const to = from + (MAX_WINDOW_MINUTES + 1) * 60_000;
    expect(() => dueScripts(from, to, jobs)).toThrow(/window/);
  });

  it('catches a monthly job when the window covers its minute', () => {
    const from = at('2026-09-01T03:30:00');
    const to = at('2026-09-01T04:30:00');
    expect(dueScripts(from, to, jobs)).toContain('scripts/monthly.mjs');
  });
});

describe('the live registry', () => {
  it('holds only expressions this matcher can read', () => {
    for (const job of SEED_JOBS) {
      expect(() => cronMatches(job.cron, Date.now()), job.cron).not.toThrow();
    }
  });

  // 30s, not the 5s default: the walk below evaluates every registry cron for
  // every minute of a month, and CI runners cross 5s while laptops don't
  // (timed out on 531030c46 and 3e8595b45 with no registry change between).
  it('reaches every scheduled script within a month', { timeout: 30_000 }, () => {
    // A job whose cron never matches would go quiet with nothing to say —
    // the failure this whole fallback exists to prevent. Walk a month in
    // day-long windows and account for every script the registry names.
    const registered = new Set(SEED_JOBS.flatMap((job) => job.scripts));
    const seen = new Set<string>();
    const start = at('2026-09-01T00:00:00');
    for (let day = 0; day < 31; day += 1) {
      const from = start + day * 24 * 60 * 60_000 - 60_000;
      const to = from + 24 * 60 * 60_000;
      for (const script of dueScripts(from, to)) seen.add(script);
    }
    expect([...registered].filter((s) => !seen.has(s))).toEqual([]);
  });
});
