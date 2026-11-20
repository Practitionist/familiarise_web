// The synchronous rails' earnings, booking journal and referral capture,
// committed with the payment in the checkout tx.

import type { Tx } from "@/lib/prisma";
import { assertWalletDebitJournaled } from "@/lib/api/organizations/wallet";
import { recordReferralCaptureInSavepoint } from "@/lib/referrals/capture";
import {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
} from "@/lib/payments/payouts";
import type { CheckoutCommitInput } from "@/lib/payments/checkout/commit/types";

export async function recordSynchronousEarnings(
  tx: Tx,
  input: CheckoutCommitInput,
  carried: {
    payment: { id: string; amount: number; expiresAt: Date | null };
    skipPayment: boolean;
  },
) {
  const { validatedData } = input;
  const { payment, skipPayment } = carried;

  // The synchronous rails confirm here, so their earnings and the
  // booking:<paymentId> journal commit with the payment or not at all.
  if (skipPayment) {
    const resolvedEarnings = await resolvePaymentForEarnings(
      { id: payment.id },
      validatedData.appointmentType,
      tx,
    );
    if (resolvedEarnings) {
      // Read back through this transaction: the capture time this commit
      // stamped on a re-bought seat, else the row's creation in this commit.
      await createEarningsFromPayment({
        payment: resolvedEarnings.paymentForEarnings,
        appointmentType: resolvedEarnings.earningsAppointmentType,
        teamAt:
          resolvedEarnings.paymentForEarnings.capturedAt ??
          resolvedEarnings.paymentForEarnings.createdAt,
        tx,
      });
    }
    if (input.isOrgWalletPayment) {
      await assertWalletDebitJournaled(tx, payment.id);
    }
    await recordReferralCaptureInSavepoint(tx, {
      paymentId: payment.id,
      consultantProfileId: () =>
        Promise.resolve(resolvedEarnings?.consultantProfileId),
    });
  }
}
