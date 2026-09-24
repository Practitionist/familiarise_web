import { WaitlistManagement } from "@/components/admin/WaitlistManagement";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function AdminWaitlistsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("waitlist.manage");
  return <WaitlistManagement />;
}
