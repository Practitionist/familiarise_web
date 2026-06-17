/**
 * Server-side prefetch helpers for the consultee dashboard. #890
 *
 * `HydrationBoundary` wraps the client page so `useQuery` can pick up a
 * cached result on first render instead of triggering a fetch waterfall.
 * The payload mirrors `/api/dashboard/consultee/[consulteeId]/events`
 * by reusing the SAME read (`readConsulteeEvents`) the route calls, then
 * returning the inner shape the client expects.
 *
 * The client `queryFn` (lib/dashboard-queries.ts → fetchWithErrorHandling)
 * unwraps the route's `{ data, success }` envelope to `json.data`, so the
 * cached value is the bare `TConsulteeEventsResponse`. This helper returns
 * exactly that — NOT the envelope — so SSR and CSR caches are identical.
 */

import { readConsulteeEvents } from "@/lib/server/consultee-events-read";
import type { Scope } from "@/lib/api/scope/parse";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

/**
 * Deterministic SSR default scope. The route's own default (no
 * `?orgScope=`) is `personal`, so the prefetch key base is
 * `["consultee-events", consulteeId, "personal"]`.
 *
 * NOTE: the client `useOrgScope({ defaultForOrgMember: "all" })` can
 * resolve to `all`/`<orgId>` for org members + ADMIN/STAFF, but that is
 * session-derived and unknowable server-side from `params` alone. For
 * those callers the mount key won't match this prefetch key, so the
 * client just falls back to its own fetch — correct, only the hydration
 * fast-path is skipped. B2C / personal-default users hydrate cleanly.
 */
const DEFAULT_SCOPE: Scope = { kind: "personal" };

export async function prefetchConsulteeEvents(
  consulteeId: string,
  scope: Scope = DEFAULT_SCOPE,
): Promise<TConsulteeEventsResponse> {
  return readConsulteeEvents(consulteeId, scope);
}

/** The scope segment of the queryKey that {@link prefetchConsulteeEvents} hydrates. */
export const DEFAULT_CONSULTEE_EVENTS_SCOPE_KEY = "personal";
