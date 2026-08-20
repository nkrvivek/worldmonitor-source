import type {
  ServerContext,
  ListNavigationalWarningsRequest,
  ListNavigationalWarningsResponse,
  NavigationalWarning,
} from '../../../../src/generated/server/worldmonitor/maritime/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { NGA_BROADCAST_WARN_URL, parseNgaBroadcastWarnings } from '../../../_shared/nga';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'maritime:navwarnings:v1';
const REDIS_CACHE_TTL = 3600; // 1 hr — NGA broadcasts update daily

// ========================================================================
// Helpers
// ========================================================================

function parseNgaDate(dateStr: unknown): number {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  // Format: "081653Z MAY 2024"
  const match = dateStr.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!match) return Date.parse(dateStr) || 0;
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const day = parseInt(match[1]!, 10);
  const hours = parseInt(match[2]!.slice(0, 2), 10);
  const minutes = parseInt(match[2]!.slice(2, 4), 10);
  const month = months[match[3]!.toUpperCase()] ?? 0;
  const year = parseInt(match[4]!, 10);
  return Date.UTC(year, month, day, hours, minutes);
}

async function fetchNgaWarnings(area?: string): Promise<NavigationalWarning[]> {
  try {
    const response = await fetch(NGA_BROADCAST_WARN_URL, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.warn(`[nav-warnings] NGA returned HTTP ${response.status}`);
      return [];
    }

    // The parse lives in _shared/nga.ts. This line read `broadcast_warn` with
    // an underscore while NGA ships `broadcast-warn` with a hyphen, so every
    // response became an empty list and nothing threw. get-cable-health had the
    // same fault under a different wrong key, which is why one endpoint no
    // longer gets two private parsers.
    const rawWarnings = parseNgaBroadcastWarnings(await response.json());
    if (rawWarnings === null) {
      console.warn('[nav-warnings] NGA returned an unrecognized payload shape');
      return [];
    }

    let warnings: NavigationalWarning[] = rawWarnings.map((w: any): NavigationalWarning => ({
      id: `${w.navArea || ''}-${w.msgYear || ''}-${w.msgNumber || ''}`,
      title: `NAVAREA ${w.navArea || ''} ${w.msgNumber || ''}/${w.msgYear || ''}`,
      text: w.text || '',
      area: `${w.navArea || ''}${w.subregion ? ' ' + w.subregion : ''}`,
      location: undefined,
      issuedAt: parseNgaDate(w.issueDate),
      expiresAt: 0,
      authority: w.authority || '',
    }));

    if (area) {
      const areaLower = area.toLowerCase();
      warnings = warnings.filter(
        (w) =>
          w.area.toLowerCase().includes(areaLower) ||
          w.text.toLowerCase().includes(areaLower),
      );
    }

    return warnings;
  } catch {
    return [];
  }
}

// ========================================================================
// RPC handler
// ========================================================================

export async function listNavigationalWarnings(
  _ctx: ServerContext,
  req: ListNavigationalWarningsRequest,
): Promise<ListNavigationalWarningsResponse> {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.area || 'all'}`;
    const result = await cachedFetchJson<ListNavigationalWarningsResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
      const warnings = await fetchNgaWarnings(req.area);
      return warnings.length > 0 ? { warnings, pagination: undefined } : null;
    });
    return result || { warnings: [], pagination: undefined };
  } catch {
    return { warnings: [], pagination: undefined };
  }
}
