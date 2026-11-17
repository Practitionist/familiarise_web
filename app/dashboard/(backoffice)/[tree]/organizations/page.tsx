import { requireBackofficePage } from "@/lib/auth-guard";
import { pageNumberSchema } from "@/lib/backoffice/list-paging";
import { readPendingSsoApprovals } from "@/lib/backoffice/org-detail";
import OrganizationsPageClient from "./OrganizationsPageClient";

/** Organization lifecycle — admin only. `?ssoPage` pages the SSO approval queue. */
export default async function Page({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tree: string }>;
  searchParams: Promise<{ ssoPage?: string | string[] }>;
}>) {
  await requireBackofficePage("organizations.manage", (await params).tree);
  const { ssoPage } = await searchParams;
  const pendingSso = await readPendingSsoApprovals(
    pageNumberSchema.parse(typeof ssoPage === "string" ? ssoPage : undefined),
  );
  return <OrganizationsPageClient pendingSso={pendingSso} />;
}
