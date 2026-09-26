import { notFound } from "next/navigation";

import { requireBackofficePage } from "@/lib/auth-guard";
import { readOrgDetail } from "@/lib/backoffice/org-detail";
import { OrgDetailClient } from "./OrgDetailClient";

/** #1527 — one organization: status, KYB/GST, billing, lifecycle, invoicing. */
export default async function BackofficeOrgDetailPage({
  params,
}: Readonly<{ params: Promise<{ tree: string; orgId: string }> }>) {
  const { tree, orgId } = await params;
  await requireBackofficePage("organizations.manage", tree);
  const org = await readOrgDetail(orgId);
  if (!org) notFound();
  return <OrgDetailClient org={org} />;
}
