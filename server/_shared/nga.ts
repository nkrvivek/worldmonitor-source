/**
 * NGA Maritime Safety Information broadcast warnings.
 *
 * Two handlers read this one endpoint — get-cable-health (which infers cable
 * faults from warning text) and list-navigational-warnings — and on 2026-08-13
 * both were reading a key that does not exist. get-cable-health looked for
 * `warnings`; list-navigational-warnings looked for `broadcast_warn` with an
 * underscore. The live payload is `{"broadcast-warn": [...]}` with a hyphen.
 *
 * Neither miss threw. `?? []` turned a 386-row response into an empty array,
 * and an empty array is not an error: get-cable-health cached it under a 24h
 * TTL and served an empty cable map — a calm sea — for the rest of the day.
 *
 * So the parse lives in one place, and an unrecognized shape returns null
 * rather than an empty list. Null is a failure the callers already handle by
 * not caching. `[]` is a measurement, and this endpoint must only be able to
 * report one when NGA actually said so.
 */

export const NGA_BROADCAST_WARN_URL =
  'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A';

/** The key NGA documents and ships. Hyphen, not underscore. */
const BROADCAST_WARN_KEY = 'broadcast-warn';

/**
 * Returns the warning rows, or null when the payload is not a shape we know.
 *
 * A recognized payload holding zero rows returns `[]` — that is NGA reporting
 * no active warnings, which is a real reading. Only an unrecognized shape
 * returns null, so a renamed key surfaces as an upstream failure instead of
 * silently becoming quiet seas.
 */
export function parseNgaBroadcastWarnings(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const rows = (data as Record<string, unknown>)[BROADCAST_WARN_KEY];
    if (Array.isArray(rows)) return rows;
  }
  return null;
}
