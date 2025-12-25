"use client";

import ReactDOM from "react-dom";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const GITHUB_AVATARS_URL = "https://avatars.githubusercontent.com";

/**
 * Preloads critical external resources using React 19 ReactDOM methods.
 * This is the recommended approach for Next.js App Router.
 * @see https://github.com/vercel/next.js/discussions/49611
 */
export function PreloadResources() {
  // Preconnect to Supabase (database/storage)
  if (SUPABASE_URL) {
    ReactDOM.preconnect(SUPABASE_URL);
    ReactDOM.prefetchDNS(SUPABASE_URL);
  }

  // Preconnect to GitHub (avatars)
  ReactDOM.preconnect(GITHUB_AVATARS_URL);
  ReactDOM.prefetchDNS(GITHUB_AVATARS_URL);

  return null;
}
