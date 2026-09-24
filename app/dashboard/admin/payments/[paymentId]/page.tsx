import { PaymentDetailPage } from "@/components/dashboard/shared/PaymentDetailPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function AdminPaymentDetailRoute({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("payments.read");
  const { paymentId } = await params;
  return <PaymentDetailPage paymentId={paymentId} basePath="/dashboard/admin" />;
}
