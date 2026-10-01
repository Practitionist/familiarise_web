"use client";

import { useQuery } from "@tanstack/react-query";
import type { WorkspaceBillingRollup } from "@/lib/data/org-workspace";
import { workspaceBillingQueryKey } from "../workspace-billing-keys";

// One contract with the server read (lib/data/org-workspace.ts).
export type { WorkspaceBillingPerOrgRow } from "@/lib/data/org-workspace";

/**
 * Cross-org billing roll-up — the single source of truth shared by the
 * operator home overview (which reads `.summary`) and the billing page
 * (which reads both `.summary` and `.perOrg`).
 *
 * Both surfaces previously fetched `/api/org-workspace/[id]/billing` under
 * two different query keys ("org-workspace-rollup" vs "org-workspace-billing"),
 * doubling the network request and splitting the cache. One key + one fetcher
 * here collapses that to a single cached entry.
 */

async function fetchWorkspaceBilling(
  orgWorkspaceId: string,
): Promise<WorkspaceBillingRollup> {
  const res = await fetch(`/api/org-workspace/${orgWorkspaceId}/billing`);
  if (!res.ok) throw new Error("Failed to load billing roll-up");
  return res.json();
}

export function useWorkspaceBilling(orgWorkspaceId: string) {
  return useQuery({
    queryKey: workspaceBillingQueryKey(orgWorkspaceId),
    queryFn: () => fetchWorkspaceBilling(orgWorkspaceId),
  });
}
