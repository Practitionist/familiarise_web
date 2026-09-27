import { requireBackofficePage } from "@/lib/auth-guard";
import OrganizationsPageClient from "./OrganizationsPageClient";

/** Organization lifecycle — admin only. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("organizations.manage", (await params).tree);
  return <OrganizationsPageClient />;
}
