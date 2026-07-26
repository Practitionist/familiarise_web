import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";

import { ResourcesTabs } from "./ResourcesTabs";

/**
 * /dashboard/organization/[orgId]/resources — the artefacts a session leaves
 * behind: documents and recordings.
 *
 * Both were standalone sidebar entries, each a read-only `ScopedListTable`
 * of ~110 lines with no actions on it. Two nav slots for two tables was more
 * navigation than content.
 *
 * Waitlist and Trials were briefly tabs here too, under an "Operations"
 * heading. They're gone: the waitlist feature is being retired, and trials
 * belong with Appointments rather than in a separate list — a trial IS an
 * appointment. What's left is genuinely one idea, hence "Resources".
 *
 * Still gated on `operations.read`, which both surfaces already used.
 */
export default async function OrgResourcesPage({
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

  return <ResourcesTabs orgId={orgId} />;
}
