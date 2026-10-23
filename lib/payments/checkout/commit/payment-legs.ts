// The card leg, discount use and referral-credit re-read inside the checkout tx.

import type { Tx } from "@/lib/prisma";
import { applyCreditsToPayment, getUserCredits } from "@/lib/referrals/service";
import { DiscountExhaustedError } from "@/lib/payments/pricing/discount-exhausted-error";
import type { CheckoutCommitInput } from "@/lib/payments/checkout/commit/types";

export async function settleCheckoutLegs(
  tx: Tx,
  input: CheckoutCommitInput,
  carried: {
    payment: { id: string; amount: number; expiresAt: Date | null };
  },
) {
  const { userId, mintedOrder, isOrgSponsoredPayment } = input;
  const { amount, discountCodeId, creditsApplied } = input.priced;
  const { payment } = carried;

  // Enterprise: every successful Payment must have at least one
  // PaymentLeg (`docs/finance/20-ledger/03-payment-legs.md`). For non-
  // org-sponsored learner-pays-via-gateway flows that's the CARD
  // leg, written here so the invariant holds whether or not the
  // payment ever transitions to SUCCEEDED. We record the gateway
  // payment-intent id in `sourceRef` so refund / reconciliation
  // jobs can join back to the gateway txn without scanning the
  // Payment table. `amount` is the post-credit gateway charge,
  // mirroring the field-level comment on `Payment.amount`, so this
  // one leg alone carries the funding identity: the REFERRAL_CREDIT
  // leg `applyCreditsToPayment` writes further down in this same TX
  // is excluded from the sum rather than added to it (#1347).
  if (!isOrgSponsoredPayment && amount > 0) {
    await tx.paymentLeg.create({
      data: {
        paymentId: payment.id,
        source: "CARD",
        amountPaise: amount,
        sourceRef: mintedOrder.id,
      },
    });
  }

  // Increment discount code usage count atomically (only after payment is created)
  // This ensures count only increases when payment is successfully created.
  // Re-validate maxUses inside the Serializable TX: two concurrent checkouts could
  // both pass the check in calculateAmountAndValidate (non-Serializable TX) and
  // both reach here. The Serializable re-read ensures only one succeeds.
  if (discountCodeId) {
    const discountForIncrement = await tx.discountCode.findUnique({
      where: { id: discountCodeId },
      select: { maxUses: true, currentUses: true },
    });

    if (!discountForIncrement) {
      throw new Error(
        "Discount code is no longer available. Please remove the code and try again.",
      );
    }

    if (
      discountForIncrement.maxUses !== null &&
      discountForIncrement.currentUses >= discountForIncrement.maxUses
    ) {
      throw new DiscountExhaustedError(
        discountForIncrement.currentUses,
        discountForIncrement.maxUses,
      );
    }
    await tx.discountCode.update({
      where: { id: discountCodeId },
      data: { currentUses: { increment: 1 } },
    });
  }

  // FIX A3: Re-read credits inside the main transaction to prevent stale reads.
  // creditsApplied was calculated in TX1 (calculateAmountAndValidate), but between
  // TX1 and TX2, concurrent checkouts may have consumed the credits.
  let actualCreditsApplied = 0;
  let creditsRemainingAfter: number | null = null;
  if (creditsApplied > 0) {
    const { totalAvailable } = await getUserCredits(userId, tx);
    // Both creditsApplied and totalAvailable are in paise — direct comparison
    const actualCredits = Math.min(totalAvailable, creditsApplied);

    if (actualCredits > 0) {
      await applyCreditsToPayment(userId, actualCredits, tx, payment.id);
      console.log(
        `🎁 Applied ${actualCredits} paise referral credits for user ${userId}` +
          (actualCredits !== creditsApplied
            ? ` (requested ${creditsApplied} paise, available ${totalAvailable} paise)`
            : ""),
      );
    }

    // FIX #2: If fewer credits were available than expected (due to concurrent
    // checkout consuming them between TX1 and TX2), abort the transaction.
    // The payment intent was created with a reduced amount based on TX1's
    // credit calculation, so proceeding would undercharge the user.
    if (actualCredits < creditsApplied) {
      // #1586 J32 — a modelled race, answered 409 + retryAfter.
      throw Object.assign(
        new Error(
          `CREDIT_SHORTFALL: expected ${creditsApplied} paise credits but only ${actualCredits} available. ` +
            `Payment ${payment.id} amount is stale. Aborting for retry.`,
        ),
        { httpStatus: 409, code: "CREDIT_SHORTFALL", retryAfter: 2 },
      );
    }
    actualCreditsApplied = creditsApplied; // In paise
    // The balance the credits-applied bell states, read inside the
    // transaction so a later checkout cannot change it first.
    creditsRemainingAfter = (await getUserCredits(userId, tx)).totalAvailable;
  }

  return { actualCreditsApplied, creditsRemainingAfter };
}
