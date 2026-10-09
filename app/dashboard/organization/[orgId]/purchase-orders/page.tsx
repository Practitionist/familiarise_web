import { permanentRedirect } from "next/navigation";

import { orgRetiredRouteHref } from "@/lib/dashboard/org-tab-redirect";

/** #1527 Q7 — purchase orders are a Billing tab; the old URL answers a 308. */
export default async function OrgPurchaseOrdersRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgId } = await params;
  permanentRedirect(
    orgRetiredRouteHref(orgId, "purchase-orders", await searchParams),
  );
}
