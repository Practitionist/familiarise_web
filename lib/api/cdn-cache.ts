/**
 * Headers for a response Netlify's durable CDN may share across viewers.
 * Netlify keys the cache on only the query parameters `Netlify-Vary` names, so
 * every query key the route reads must be listed or one variant is served for all.
 */
export function publicCacheHeaders(opts: {
  sMaxAge: number;
  staleWhileRevalidate: number;
  /** Every query key the route reads; omit only when it reads none. */
  varyQuery?: readonly string[];
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": `public, s-maxage=${opts.sMaxAge}, stale-while-revalidate=${opts.staleWhileRevalidate}`,
  };
  if (opts.varyQuery?.length) {
    headers["Netlify-Vary"] = `query=${opts.varyQuery.join("|")}`;
  }
  return headers;
}
