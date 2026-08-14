/**
 * Where the desktop updater's release data comes from.
 *
 * Still the upstream repo, on purpose: this fork has published no releases
 * (`gh release list -R nkrvivek/worldmonitor` is empty), so pointing this at
 * our own repo would return 404 and every desktop client would stop being told
 * about updates. `.github/workflows/build-desktop.yml` builds on a version tag,
 * so the day we push one, change this line and the fallback release page in
 * api/download.js and src/app/desktop-updater.ts to nkrvivek/worldmonitor.
 *
 * Unauthenticated, so it shares GitHub's 60-requests-per-hour-per-IP budget
 * with everything else leaving this colo. A rate-limited call returns null and
 * api/version.js answers 502 — seen live on 2026-08-05, gone on retry.
 */
const RELEASES_URL = 'https://api.github.com/repos/koala73/worldmonitor/releases/latest';

export async function fetchLatestRelease(userAgent) {
  const res = await fetch(RELEASES_URL, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': userAgent,
    },
  });
  if (!res.ok) return null;
  return res.json();
}
