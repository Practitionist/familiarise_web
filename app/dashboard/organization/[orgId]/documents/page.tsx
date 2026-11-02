import { permanentRedirect } from "next/navigation";

import { orgRetiredRouteHref } from "@/lib/dashboard/org-tab-redirect";

/** A Library tab now; the old URL answers a 308 with its query kept. */
export default async function OrgDocumentsRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgId } = await params;
  permanentRedirect(
    orgRetiredRouteHref(orgId, "documents", await searchParams),
  );
}
