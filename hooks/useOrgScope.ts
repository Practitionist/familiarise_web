"use client";

/**
 * useOrgScope — client-side hook for the #674 / B1-hybrid scope split.
 * Mirrors `lib/api/scope/parse.ts` on the server side.
 *
 * URL `?orgScope=...` is the source of truth — no localStorage. Setter
 * uses `router.replace` so toggling the dropdown doesn't pollute the
 * back stack.
 *
 * Three values, three behaviors:
 *   - `personal` (default)
 *   - `<orgId>`
 *   - `all` (admin/staff only, gated server-side)
 *
 * Route-pinned mode: when the page lives under
 * `/dashboard/organization/[orgId]/...`, the `orgIdFromPath` is detected
 * and the hook forces `scope = org:<orgId>` regardless of the URL
 * param. This prevents the org dashboard from leaking into personal-
 * scope mode if a stray `?orgScope=personal` is appended.
 */

import { useCallback, useMemo } from "react";
import { useParams, useRouter, useSearchParams, usePathname } from "next/navigation";

export type Scope =
  | { kind: "personal" }
  | { kind: "org"; orgId: string }
  | { kind: "all" };

export interface UseOrgScopeResult {
  scope: Scope;
  /** URL-form serialization — `personal | <orgId> | all`. */
  serialized: string;
  setScope: (next: Scope) => void;
  /** True if the URL path pins the scope (org dashboard route). */
  pinned: boolean;
  /**
   * Convenience: the orgId the hook resolved to, or null. Backwards-
   * compatible with the older single-purpose `{ orgId }` shape.
   */
  orgId: string | null;
}

function parseRaw(raw: string | null): Scope {
  const v = raw?.trim();
  if (!v || v === "personal") return { kind: "personal" };
  if (v === "all") return { kind: "all" };
  return { kind: "org", orgId: v };
}

function serialize(scope: Scope): string {
  if (scope.kind === "personal") return "personal";
  if (scope.kind === "all") return "all";
  return scope.orgId;
}

export function useOrgScope(): UseOrgScopeResult {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const searchParams = useSearchParams();

  const orgIdFromPath =
    typeof params?.orgId === "string" ? params.orgId : null;
  const pinned = Boolean(
    orgIdFromPath && pathname?.startsWith("/dashboard/organization/"),
  );

  const scope: Scope = useMemo(() => {
    if (pinned && orgIdFromPath) {
      return { kind: "org", orgId: orgIdFromPath };
    }
    return parseRaw(searchParams?.get("orgScope") ?? null);
  }, [pinned, orgIdFromPath, searchParams]);

  const setScope = useCallback(
    (next: Scope) => {
      if (pinned) return; // No-op when route-pinned.
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      const ser = serialize(next);
      if (ser === "personal") {
        sp.delete("orgScope"); // default — keep URL clean
      } else {
        sp.set("orgScope", ser);
      }
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [pinned, pathname, router, searchParams],
  );

  return {
    scope,
    serialized: serialize(scope),
    setScope,
    pinned,
    orgId: scope.kind === "org" ? scope.orgId : null,
  };
}
