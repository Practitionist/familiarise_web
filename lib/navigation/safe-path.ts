/**
 * Single home for the sentinel-origin safe-path algorithm (Batch B6 merge of
 * `safeSameOriginPath` + `safeReturnTo`, which were the same algorithm under
 * different names/signatures).
 *
 * A bare prefix check is NOT sufficient: WHATWG URL parsing normalizes
 * backslashes to forward slashes in special schemes (`"/\attacker.example"`
 * re-tokenizes as scheme-relative and resolves externally) and deletes tab/LF/
 * CR from anywhere in the input — all while passing leading-character tests.
 * Parsing against a fixed internal sentinel origin is what actually decides:
 * whatever the browser would do to the string has already been done by the
 * time the origin is compared, and only the part that stayed on the sentinel
 * is handed back, re-serialized (never echoed raw).
 *
 * The .invalid TLD can never resolve or be fetched — the base is purely a
 * parsing reference. Isomorphic (no window dependency) so SSR and hydration
 * agree.
 */
const SENTINEL_ORIGIN = "https://safe-path.invalid";

/** Canonical same-origin path, or null when the input escapes the site. */
function resolveSafePath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const parsed = new URL(raw, SENTINEL_ORIGIN);
    if (parsed.origin !== SENTINEL_ORIGIN) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/**
 * Isomorphic same-origin callback-URL validation for auth redirects.
 * Returns the canonical path?query#hash, or null when unsafe.
 */
export function safeSameOriginPath(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return resolveSafePath(raw);
}

/**
 * Narrows a caller-supplied `?returnTo=` hop to a path on this site.
 * Non-strings (e.g. repeated query keys arriving as `string[]`) and unsafe
 * inputs fall back — the type is checked, not assumed.
 */
export function safeReturnTo(
  raw: string | string[] | undefined,
  fallback: string,
): string {
  // Site-relative only: a bare "dashboard/x" would resolve against the
  // sentinel root and look safe, but it is not the documented contract.
  if (typeof raw !== "string") return fallback;
  return resolveSafePath(raw) ?? fallback;
}
