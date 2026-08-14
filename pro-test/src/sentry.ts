import * as Sentry from '@sentry/react';

/**
 * Shared Sentry bootstrap for both marketing entries (/pro and root welcome).
 * Must be imported before the React render in every entry's main file.
 */
export function initSentry(): void {
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();

  Sentry.init({
    dsn: sentryDsn || undefined,
    environment: (location.hostname === 'worldmonitor.sibt.ai' || location.hostname === 'worldmonitor.app' || location.hostname.endsWith('.worldmonitor.app')) ? 'production'
      : location.hostname.includes('vercel.app') ? 'preview'
      : 'development',
    enabled: Boolean(sentryDsn) && !location.hostname.startsWith('localhost'),
    allowUrls: [
      // This fork's host first: without it Sentry dropped every event our
      // pages raised, because allowUrls filters by the frame's script origin.
      /https?:\/\/worldmonitor\.sibt\.ai/,
      /https?:\/\/(www\.|tech\.|finance\.|commodity\.|happy\.)?worldmonitor\.app/,
      /https?:\/\/.*\.vercel\.app/,
    ],
    tracesSampleRate: 0.1,
    ignoreErrors: [
      /ResizeObserver loop/,
      /^TypeError: Load failed/,
      /^TypeError: Failed to fetch/,
      /^TypeError: NetworkError/,
      /Non-Error promise rejection captured with value:/,
    ],
  });
}
