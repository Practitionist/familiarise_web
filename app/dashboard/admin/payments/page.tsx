import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Payment list — shared with the staff tree. Refunds are their own route. */
export default async function AdminPaymentsPage() {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("payments.read");
  return <PaymentsPage basePath="/dashboard/admin" />;
}
