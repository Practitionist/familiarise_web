import type { Session } from "@/lib/auth";

/**
 * The scope segment a page should PREFETCH, resolved on the server.
 *
 * Must stay a mirror of `useOrgScope`'s default rule (hooks/useOrgScope.ts).
 * The scope is part of the query key — `["consultant-appointments", id,
 * scopeKey]` — so if the two disagree the prefetch is silently wasted and the
 * client refetches.
 *
 * They disagreed by construction until now. `useOrgScope` read the role and
 * memberships from `useSession()`, which is pending during SSR, so it always
 * resolved `personal` there; the pages worked around that by hard-coding a
 * `"personal"` prefetch and accepting that org members get no hydration on
 * their busiest tab. Now that the hook falls back to server-resolved facts,
 * the pages have to resolve the same way or the mismatch simply inverts.
 *
 * `?orgScope=` still wins, exactly as the hook honours the URL first.
 */
export type ScopeKey = "personal" | "all" | (string & {});

export function resolveDefaultScopeKey(
  session: Session | null,
  options: {
    defaultForOrgMember?: "first-org" | "all" | "personal";
    orgScopeParam?: string | null;
  } = {},
): ScopeKey {
  const { defaultForOrgMember = "first-org", orgScopeParam = null } = options;

  const raw = orgScopeParam?.trim();
  if (raw) return raw;

  if (defaultForOrgMember === "personal") return "personal";

  const role = session?.user?.role;
  if (role === "ADMIN" || role === "STAFF") return "all";

  const firstOrgId =
    session?.user?.organizationMemberships?.[0]?.organizationId ?? null;
  if (firstOrgId) {
    return defaultForOrgMember === "all" ? "all" : firstOrgId;
  }

  return "personal";
}

/** The `Scope` object form, for reads that take a scope rather than a filter. */
export function scopeFromKey(
  scopeKey: ScopeKey,
): { kind: "personal" } | { kind: "all" } | { kind: "org"; orgId: string } {
  if (scopeKey === "personal") return { kind: "personal" };
  if (scopeKey === "all") return { kind: "all" };
  return { kind: "org", orgId: scopeKey };
}
