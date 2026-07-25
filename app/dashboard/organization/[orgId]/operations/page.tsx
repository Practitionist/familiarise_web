import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";

import { OperationsTabs } from "./OperationsTabs";

/**
 * /dashboard/organization/[orgId]/operations — the org's booking-side data
 * feeds, previously four separate sidebar entries.
 *
 * Waitlist, Trials, Documents and Recordings were each a read-only
 * `ScopedListTable` with no actions on it — roughly 110 lines apiece. Four
 * nav slots for four tables was more navigation than content, so they're tabs
 * on one destination now. Their old routes redirect to `?tab=`.
 *
 * All four shared a single `operations.read` gate, so the page guard is that
 * same key and the tabs need no further per-tab gating.
 */
export default async function OrgOperationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  return <OperationsTabs orgId={orgId} />;
}
