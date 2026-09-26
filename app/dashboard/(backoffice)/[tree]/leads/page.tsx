import { LeadsManagement } from "@/components/admin/LeadsManagement";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeLeadsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("leads.manage", (await params).tree);
  return <LeadsManagement />;
}
