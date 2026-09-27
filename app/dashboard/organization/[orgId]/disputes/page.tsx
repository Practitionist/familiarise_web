import { permanentRedirect } from "next/navigation";

import { orgTabHref } from "@/lib/dashboard/org-tab-redirect";

/** #1527 Q7 — disputes are a Billing tab; the old URL answers a 308. */
export default async function OrgDisputesRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgId } = await params;
  permanentRedirect(
    orgTabHref(orgId, "billing", "disputes", await searchParams),
  );
}
