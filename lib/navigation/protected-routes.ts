/** Page prefixes that require a session; the edge middleware and the client share them. */
export const PROTECTED_PAGE_PREFIXES = [
  "/form/",
  "/dashboard/",
  "/settings/",
  "/profile/",
  "/checkout/",
  "/meetings/",
] as const;

/** `prefix` matches its own bare path (`/dashboard`) and everything under it. */
export function matchesPrefix(pathname: string, prefix: string): boolean {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PAGE_PREFIXES.some((prefix) =>
    matchesPrefix(pathname, prefix),
  );
}
