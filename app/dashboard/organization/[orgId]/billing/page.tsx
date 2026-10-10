import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  getOrgReceivables,
  type OrgReceivablesPayload,
} from "@/lib/data/org-receivables";

import { BillingPageClient } from "./BillingPageClient";

export default async function OrgBillingPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, {
    permission: "billing.read",
    canSponsor: true,
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }
  const receivables: OrgReceivablesPayload | null =
    await getOrgReceivables(orgId);

  return <BillingPageClient orgId={orgId} receivables={receivables} />;
}
