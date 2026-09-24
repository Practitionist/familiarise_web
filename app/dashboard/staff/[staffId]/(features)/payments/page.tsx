import { PaymentsPage } from "@/components/dashboard/shared/PaymentsPage";
import { requireBackofficePage } from "@/lib/auth-guard";

/** Payment list — shared with the admin tree. Refunds are their own route. */
export default async function StaffPaymentsPage({
  params,
}: {
  params: Promise<{ staffId: string }>;
}) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("payments.read");
  const { staffId } = await params;
  return <PaymentsPage basePath={`/dashboard/staff/${staffId}`} />;
}
