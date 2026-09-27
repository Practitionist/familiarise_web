import { notFound, redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";

import { NewOrgOfferingClient } from "./NewOrgOfferingClient";

/**
 * ORG-01 (#1527): the same gate as the Catalog page, and only the kinds the
 * org catalog API accepts. Consultation and subscription plans need a
 * consultant owner, so `POST …/catalog` refuses them.
 */
const ORG_OFFERING_TYPES = ["webinar", "class"] as const;
type OrgOfferingType = (typeof ORG_OFFERING_TYPES)[number];

const isOrgOfferingType = (type: string): type is OrgOfferingType =>
  (ORG_OFFERING_TYPES as readonly string[]).includes(type);

export default async function NewOrgOfferingPage({
  params,
}: Readonly<{ params: Promise<{ orgId: string; type: string }> }>) {
  const { orgId, type } = await params;
  if (!isOrgOfferingType(type)) notFound();

  const access = await requireOrgAccess(orgId, {
    permission: "catalog.manage",
    canHost: true,
  });
  if (access.error) redirect(`/dashboard/organization/${orgId}/home`);

  return <NewOrgOfferingClient orgId={orgId} type={type} />;
}
