import { permanentRedirect, redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { orgLegacyTabHref } from "@/lib/dashboard/org-tab-redirect";
import {
  getOrgReceivables,
  type OrgReceivablesPayload,
} from "@/lib/data/org-receivables";

import { BillingPageClient } from "./BillingPageClient";

export default async function OrgBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "billing.read",
    canSponsor: true,
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }
  const legacy = orgLegacyTabHref(orgId, "billing", await searchParams);
  if (legacy) permanentRedirect(legacy);
  const receivables: OrgReceivablesPayload | null =
    await getOrgReceivables(orgId);

  return <BillingPageClient orgId={orgId} receivables={receivables} />;
}
