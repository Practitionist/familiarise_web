import { requireBackofficePage } from "@/lib/auth-guard";
import { readPendingSsoApprovals } from "@/lib/backoffice/org-detail";
import OrganizationsPageClient from "./OrganizationsPageClient";

/** Organization lifecycle — admin only. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("organizations.manage", (await params).tree);
  const pendingSso = await readPendingSsoApprovals();
  return <OrganizationsPageClient pendingSso={pendingSso} />;
}
