import { LeadsManagement } from "@/components/admin/LeadsManagement";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function AdminLeadsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("leads.manage");
  return <LeadsManagement />;
}
