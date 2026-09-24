import { SupportThreadsPage } from "@/components/dashboard/shared/SupportThreadsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** #support-hub — per-appointment conversation inbox — shared with the staff tree. */
export default async function AdminThreadsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("threads.manage");
  return <SupportThreadsPage />;
}
