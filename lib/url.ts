/**
 * Shared application URL utility.
 *
 * Single source of truth for the app's base URL. Supports Netlify (current)
 * and Vercel (future) hosting with automatic env var detection.
 *
 * Resolution order:
 * 1. NEXT_PUBLIC_APP_URL — explicit override, always wins (set in .env / hosting dashboard)
 * 2. URL                 — auto-set by Netlify with protocol (e.g., "https://familiarise.com")
 * 3. VERCEL_URL          — auto-set by Vercel without protocol (e.g., "my-app.vercel.app")
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
