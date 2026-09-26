import { PaymentDetailPage } from "@/components/dashboard/shared/PaymentDetailPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficePaymentDetailRoute({
  params,
}: Readonly<{ params: Promise<{ tree: string; paymentId: string }> }>) {
  const { tree, paymentId } = await params;
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("payments.read", tree);
  return <PaymentDetailPage paymentId={paymentId} />;
}
