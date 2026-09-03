/**
 * GSCPI (NY Fed Global Supply Chain Pressure Index).
 *
 * FRED does not carry this series, so it is fetched from the NY Fed's own CSV
 * and written under a FRED-compatible key. The fetch and parser lived in
 * scripts/ais-relay.cjs (seedGscpi) until that Railway relay was retired; only
 * /ais/snapshot was ported to the Worker, so nothing wrote the key any more and
 * `gscpi` read EMPTY at /api/health from the cutover onward. scripts/seed-economy.mjs
 * now carries it: that seeder already reads GSCPI for its stress index, and it is
 * scheduled daily, which matches the old 24h loop.
 */

import { CHROME_UA, curlFetch } from './_seed-utils.mjs';

export const GSCPI_CSV_URL =
  'https://www.newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv';
export const GSCPI_REDIS_KEY = 'economic:fred:v1:GSCPI:0'; // FRED-compatible key
// api/health.js reads this exact meta key (maxStaleMin 2880). The default
// derivation from the data key would produce seed-meta:economic:fred:v1:GSCPI:0
// and the health row would stay EMPTY while the data was fine.
export const GSCPI_META_KEY = 'seed-meta:economic:gscpi';
export const GSCPI_TTL = 259200; // 72h — 3x the daily interval; survives 2 missed runs

const MONTH_MAP = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/**
 * Parse the NY Fed CSV into FRED-shaped observations, oldest first.
 * Each row carries one column per vintage; the last readable column is the
 * latest estimate for that month.
 * @param {string} text
 * @returns {{ date: string; value: number }[]}
 */
export function parseGscpiCsv(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim() && !l.startsWith(','));
  const observations = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dateStr = cols[0]?.trim();
    if (!dateStr) continue;
    let value = null;
    for (let j = cols.length - 1; j >= 1; j--) {
      const v = cols[j]?.trim();
      if (v && v !== '#N/A') {
        const num = Number.parseFloat(v);
        if (!Number.isNaN(num)) {
          value = num;
          break;
        }
      }
    }
    if (value === null) continue;
    // "31-Jan-2026" → "2026-01-01"
    const parts = dateStr.split('-');
    if (parts.length !== 3) continue;
    const mon = MONTH_MAP[parts[1]];
    const year = parts[2];
    if (!mon || !year) continue;
    observations.push({ date: `${year}-${mon}-01`, value });
  }
  return observations.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Wrap observations in the shape GetFredSeriesBatch already serves.
 * @param {{ date: string; value: number }[]} observations
 */
export function buildGscpiPayload(observations) {
  return {
    series: {
      series_id: 'GSCPI',
      title: 'Global Supply Chain Pressure Index',
      units: 'Standard Deviations',
      frequency: 'Monthly',
      observations,
    },
  };
}

/**
 * Fetch the CSV direct, falling back to the proxy the way the relay did.
 * Returns null rather than throwing: a missing GSCPI drops one stress-index
 * component, it does not fail the economy seed.
 * @param {string | undefined} proxyAuth
 * @returns {Promise<{ date: string; value: number }[] | null>}
 */
export async function fetchGscpiFromNyFed(proxyAuth) {
  let text = null;
  try {
    const resp = await fetch(GSCPI_CSV_URL, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    text = await resp.text();
  } catch (directErr) {
    if (!proxyAuth) {
      console.warn(`  [GSCPI] NY Fed fetch failed: ${directErr?.message}`);
      return null;
    }
    console.warn(`  [GSCPI] Direct failed (${directErr?.message}) — retrying via proxy`);
    try {
      text = curlFetch(GSCPI_CSV_URL, proxyAuth, {
        'User-Agent': CHROME_UA,
        Accept: 'text/csv,text/plain',
      }, { timeoutMs: 20_000 });
    } catch (proxyErr) {
      console.warn(`  [GSCPI] Proxy fetch failed: ${proxyErr?.message}`);
      return null;
    }
  }
  const observations = parseGscpiCsv(text ?? '');
  if (observations.length === 0) {
    console.warn('  [GSCPI] CSV parsed to zero observations — layout may have changed');
    return null;
  }
  return observations;
}
