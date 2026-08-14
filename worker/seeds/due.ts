/**
 * Which seed scripts a catch-up run owes, for a window of wall-clock time.
 *
 * Cloudflare's cron scheduler hands `scheduled()` the exact expression that
 * fired, so `registry.scriptsForCron` only ever needs an exact-string lookup.
 * A fallback runner has no such gift: it wakes up, sees that some minutes
 * passed, and has to work out for itself which of the registry's expressions
 * would have fired in between. That is what this file is for.
 *
 * The registry stays the single source of cadence. Nothing here holds a
 * schedule of its own, and nothing here imports a Cloudflare type, so the
 * module loads under plain Node the same way `registry.ts` does.
 *
 * Everything is UTC. Cloudflare schedules crons in UTC and the runner reads
 * the same clock, so a local-time reading here would drift the whole set by
 * the runner's offset twice a year.
 */
import { SEED_JOBS, type SeedJob } from './registry';

const MINUTE_MS = 60_000;

/**
 * How far back a single run will walk. A catch-up that has been down for a
 * week should refill today, not replay the week: the seeds overwrite the same
 * keys, so the older passes buy nothing and cost the whole rate budget. The
 * cap also bounds the work when a clock or an input date is wrong.
 */
export const MAX_WINDOW_MINUTES = 1440;

const DAY_NAMES: Readonly<Record<string, number>> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

type FieldSpec = {
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
};

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 },                    // minute
  { min: 0, max: 23 },                    // hour
  { min: 1, max: 31 },                    // day of month
  { min: 1, max: 12, names: MONTH_NAMES }, // month
  { min: 0, max: 6, names: DAY_NAMES },   // day of week
];

function toNumber(token: string, spec: FieldSpec, cron: string): number {
  const named = spec.names?.[token.toUpperCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new Error(`cron ${cron}: cannot read "${token}"`);
  }
  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    throw new Error(`cron ${cron}: "${token}" outside ${spec.min}-${spec.max}`);
  }
  return value;
}

/**
 * The set of values one field allows. Supports a bare star, a star with a
 * step, a range, a range with a step, lists of any of those, and names for
 * month and weekday.
 *
 * Anything else throws. A parser that returned an empty set on a token it did
 * not understand would turn a typo into a seed that quietly never runs again,
 * and the run would still report a clean pass — the exact failure this
 * fallback was built to catch.
 */
function fieldValues(field: string, spec: FieldSpec, cron: string): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range = '', step] = part.split('/');
    if (step !== undefined && !/^\d+$/.test(step)) {
      throw new Error(`cron ${cron}: cannot read step "${step}"`);
    }
    const by = step === undefined ? 1 : Number(step);
    if (by < 1) throw new Error(`cron ${cron}: step "${step}" must be at least 1`);

    let from = spec.min;
    let to = spec.max;
    if (range !== '*') {
      const [low, high, ...rest] = range.split('-');
      if (low === undefined || rest.length > 0) {
        throw new Error(`cron ${cron}: cannot read "${part}"`);
      }
      from = toNumber(low, spec, cron);
      to = high === undefined ? from : toNumber(high, spec, cron);
      // A bare `a/n` means "from a to the top of the field, every n".
      if (high === undefined && step !== undefined) to = spec.max;
      if (to < from) throw new Error(`cron ${cron}: range "${part}" runs backwards`);
    }
    for (let value = from; value <= to; value += by) values.add(value);
  }
  return values;
}

/** True when `cron` fires at the minute containing `ms`. */
export function cronMatches(cron: string, ms: number): boolean {
  const fields = cron.trim().split(/\s+/);
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (
    minuteField === undefined ||
    hourField === undefined ||
    domField === undefined ||
    monthField === undefined ||
    dowField === undefined ||
    fields.length !== FIELDS.length
  ) {
    throw new Error(`cron ${cron}: expected 5 fields, got ${fields.length}`);
  }
  const minute = fieldValues(minuteField, FIELDS[0]!, cron);
  const hour = fieldValues(hourField, FIELDS[1]!, cron);
  const dom = fieldValues(domField, FIELDS[2]!, cron);
  const month = fieldValues(monthField, FIELDS[3]!, cron);
  const dow = fieldValues(dowField, FIELDS[4]!, cron);

  const at = new Date(ms);
  if (!minute.has(at.getUTCMinutes())) return false;
  if (!hour.has(at.getUTCHours())) return false;
  if (!month.has(at.getUTCMonth() + 1)) return false;

  // Standard cron: when BOTH day fields are restricted a match on either one
  // fires. When only one is restricted, that one decides. `0 4 1 * *` must not
  // wait for a Sunday, and `0 3 * * SUN` must not wait for the 1st.
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  const domHit = dom.has(at.getUTCDate());
  const dowHit = dow.has(at.getUTCDay());
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

/**
 * Every script whose cron would have fired in `(fromExclusive, toInclusive]`,
 * deduplicated, in the order the registry names them.
 *
 * The start is exclusive so consecutive runs neither skip a minute nor run one
 * twice: a run covering up to 14:00 owns 14:00, and the next run starts after
 * it. Callers pass the previous run's end as the new start.
 */
export function dueScripts(
  fromExclusiveMs: number,
  toInclusiveMs: number,
  jobs: readonly SeedJob[] = SEED_JOBS,
): string[] {
  if (!(toInclusiveMs > fromExclusiveMs)) return [];
  const minutes = Math.ceil((toInclusiveMs - fromExclusiveMs) / MINUTE_MS);
  if (minutes > MAX_WINDOW_MINUTES) {
    throw new Error(
      `window of ${minutes} minutes exceeds the ${MAX_WINDOW_MINUTES}-minute cap`,
    );
  }

  const due = new Set<string>();
  // Walk minute by minute from the first whole minute after the start. Ceiling
  // rather than floor: a start of 14:00:30 has already passed 14:00.
  const first = Math.ceil((fromExclusiveMs + 1) / MINUTE_MS) * MINUTE_MS;
  for (let ms = first; ms <= toInclusiveMs; ms += MINUTE_MS) {
    for (const job of jobs) {
      if (cronMatches(job.cron, ms)) for (const script of job.scripts) due.add(script);
    }
  }

  const ordered = jobs.flatMap((job) => job.scripts);
  return [...new Set(ordered)].filter((script) => due.has(script));
}
