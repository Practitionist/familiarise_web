/**
 * Shared application URL utility.
 *
 * Single source of truth for the app's base URL. Resolution order:
 * 1. NEXT_PUBLIC_APP_URL — `next.config.mjs` inlines it per deploy context at
 *    build time (a preview's own `DEPLOY_PRIME_URL` off production), so Next
 *    code always addresses its own deploy.
 * 2. URL               — auto-set by Netlify, the SITE's primary URL. Note
 *    this is production even on a preview build, hence its low rank.
 * 3. VERCEL_URL        — auto-set by Vercel without protocol.
 * 4. http://localhost:3000 — local dev fallback
 */
export function getAppUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }

  // Netlify auto-sets URL (includes protocol)
  if (process.env.URL) {
    return process.env.URL;
  }

  // Vercel auto-sets VERCEL_URL (no protocol)
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3000";
}
