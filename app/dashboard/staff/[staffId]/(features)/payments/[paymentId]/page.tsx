import { PaymentDetailPage } from "@/components/dashboard/shared/PaymentDetailPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function StaffPaymentDetailRoute({
  params,
}: {
  params: Promise<{ staffId: string; paymentId: string }>;
}) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("payments.read");
  const { staffId, paymentId } = await params;
  return (
    <PaymentDetailPage
      paymentId={paymentId}
      basePath={`/dashboard/staff/${staffId}`}
    />
  );
}
