import { permanentRedirect } from "next/navigation";

import { orgTabHref } from "@/lib/dashboard/org-tab-redirect";

/** #1527 Q7 — reimbursements are Billing › Member spend; the old URL 308s. */
export default async function OrgReimbursementsRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgId } = await params;
  permanentRedirect(
    orgTabHref(orgId, "billing", "member-spend", await searchParams),
  );
}
