import { permanentRedirect } from "next/navigation";

import { orgTabHref } from "@/lib/dashboard/org-tab-redirect";

/** #1527-4d — materials are a Catalog tab; the old URL answers a 308. */
export default async function OrgMaterialsRedirect({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { orgId } = await params;
  permanentRedirect(
    orgTabHref(orgId, "catalog", "materials", await searchParams),
  );
}
