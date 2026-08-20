// CelesTrak TLE parsing and classification.
//
// Ported 2026-08-19 from seedSatelliteTLEs in scripts/ais-relay.cjs (:1890-2010).
// The relay is retired; only /ais/snapshot moved to the Durable Object, so this
// seed had no home and intelligence:satellites:tle:v1 went dark. Kept as its own
// module so the parse and the filter are testable without a network call.

export const SAT_GROUPS = ['military', 'resource'];

// Names we track. A satellite outside this list is not "unknown", it is not
// intelligence-relevant, so it is dropped rather than classified as OTHER.
export const SAT_NAME_FILTERS = [
  /^YAOGAN/i, /^GAOFEN/i, /^JILIN/i,
  /^COSMOS 2[4-9]\d{2}/i,
  /^COSMO-SKYMED/i, /^TERRASAR/i, /^PAZ$/i, /^SAR-LUPE/i,
  /^WORLDVIEW/i, /^SKYSAT/i, /^PLEIADES/i, /^KOMPSAT/i,
  /^SAPPHIRE/i, /^PRAETORIAN/i,
  /^SENTINEL/i,
  /^CARTOSAT/i,
  /^GOKTURK/i, /^RASAT/i,
  /^USA[ -]?\d/i,
  /^ZIYUAN/i,
];

export function satClassify(name) {
  const n = name.toUpperCase();
  let type = 'military';
  if (/COSMO-SKYMED|TERRASAR|PAZ|SAR-LUPE|YAOGAN/i.test(n)) type = 'sar';
  else if (/WORLDVIEW|SKYSAT|PLEIADES|KOMPSAT|GAOFEN|JILIN|CARTOSAT|ZIYUAN/i.test(n)) type = 'optical';
  else if (/SAPPHIRE|PRAETORIAN|USA|GOKTURK/i.test(n)) type = 'military';

  let country = 'OTHER';
  if (/^YAOGAN|^GAOFEN|^JILIN|^ZIYUAN/i.test(n)) country = 'CN';
  else if (/^COSMOS/i.test(n)) country = 'RU';
  else if (/^WORLDVIEW|^SAPPHIRE|^PRAETORIAN|^USA|^SKYSAT/i.test(n)) country = 'US';
  else if (/^SENTINEL|^COSMO-SKYMED|^TERRASAR|^SAR-LUPE|^PAZ|^PLEIADES/i.test(n)) country = 'EU';
  else if (/^KOMPSAT/i.test(n)) country = 'KR';
  else if (/^CARTOSAT/i.test(n)) country = 'IN';
  else if (/^GOKTURK|^RASAT/i.test(n)) country = 'TR';

  return { type, country };
}

// 3-line TLE sets. Both element lines are exactly 69 characters; anything else
// is a truncated or wrapped response and is skipped rather than half-parsed.
export function parseTleText(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  const lines = text.split('\n').map((l) => l.trimEnd());
  for (let i = 0; i < lines.length - 2; i++) {
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    if (l1.length !== 69 || l2.length !== 69) continue;
    out.push({
      noradId: l1.substring(2, 7).trim(),
      name: lines[i].trim(),
      line1: l1,
      line2: l2,
    });
    i += 2;
  }
  return out;
}

// First group wins on a NORAD id collision, matching the relay: `military` is
// listed before `resource` and carries the better name for a dual-listed bird.
export function buildSatelliteList(texts) {
  const byNorad = new Map();
  for (const text of texts) {
    for (const sat of parseTleText(text)) {
      if (!byNorad.has(sat.noradId)) byNorad.set(sat.noradId, sat);
    }
  }
  const satellites = [];
  for (const sat of byNorad.values()) {
    if (!SAT_NAME_FILTERS.some((rx) => rx.test(sat.name))) continue;
    satellites.push({ ...sat, ...satClassify(sat.name) });
  }
  return satellites;
}
