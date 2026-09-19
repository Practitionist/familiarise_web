/**
 * Trial pay-link persistence and re-mint (#1583 A-P0-06, #1589 T-P1-02,
 * #1591 J4-P1-02 / J4-P1-03).
 *
 * The accept path mints the pay-link after its transaction commits and then
 * stored it with a bare `update`, so a mint that landed after the expiry sweep
 * had already cancelled the trial re-armed a link on a released slot; and a
 * mint whose persist failed left an AWAITING_PAYMENT trial with no link at
 * all, which the checkout page reads as "unavailable" until the sweep cancels
 * it. Both fixes live here: the persist is a CAS on the exact shape the link
 * belongs to, and a consultee-facing read can re-mint a lost link while the
 * pay window is still open.
 */

import { PaymentGateway, PaymentStatus, TrialStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { createApprovalPaymentIntent } from "@/lib/payments/operations/approval-payment";

/**
 * Persist a freshly minted pay-link only onto the trial that is still waiting
 * for one. Zero rows means the trial moved (cancelled by the sweep, paid, or a
 * concurrent mint won) between the mint and this write; the row is left alone
 * and the orphaned intent is reported so the sweep or a later re-mint
 * reconciles it. Never throws on the lost race.
 */
export async function persistTrialPayLink(args: {
  trialId: string;
  paymentIntentId: string;
  checkoutUrl: string;
}): Promise<boolean> {
  const res = await prisma.trial.updateMany({
    where: {
      id: args.trialId,
      status: TrialStatus.AWAITING_PAYMENT,
      pendingPaymentUrl: null,
    },
    data: { pendingPaymentUrl: args.checkoutUrl },
  });
  if (res.count === 0) {
    reportSentryMessage("PAY_LINK_ORPHANED", {
      subsystem: "trials",
      op: "trial-pay-link-persist",
      expected: true,
      extra: { trialId: args.trialId, paymentIntentId: args.paymentIntentId },
    });
    return false;
  }
  return true;
}

export interface TrialPayLinkSubject {
  id: string;
  status: TrialStatus;
  pendingPaymentUrl: string | null;
  paymentDueAt: Date | null;
  subscriptionPlanId: string;
  consulteeProfile: { userId: string };
  appointment: {
    id: string;
    occurrences: { startsAt: Date; endsAt: Date }[];
  } | null;
}

/** True when the trial should have a live link and does not. */
export function needsTrialPayLinkRemint(
  trial: Pick<
    TrialPayLinkSubject,
    "status" | "pendingPaymentUrl" | "paymentDueAt"
  >,
  now = new Date(),
): boolean {
  return (
    trial.status === TrialStatus.AWAITING_PAYMENT &&
    trial.pendingPaymentUrl === null &&
    trial.paymentDueAt !== null &&
    trial.paymentDueAt > now
  );
}

/**
 * Re-mint a lost pay-link for an AWAITING_PAYMENT trial whose window is still
 * open, mirroring the consultation route's `needsLinkRetry` branch: a live
 * PENDING intent on the held appointment is reused (its stored intent IS the
 * checkout hand-off), so no second gateway order is minted when one exists;
 * only when none does is a new one created, under the same
 * `approval-payment-mint:trial:<id>` atom the accept path holds. Returns the
 * link, or null when nothing could be minted — the caller renders "unavailable"
 * exactly as before.
 */
export async function remintTrialPayLink(
  trial: TrialPayLinkSubject,
): Promise<string | null> {
  if (!needsTrialPayLinkRemint(trial)) return trial.pendingPaymentUrl;
  const slot = trial.appointment?.occurrences[0];
  if (!trial.appointment || !slot) return null;

  try {
    const now = new Date();
    // The trial arm of createApprovalPaymentIntent resolves an existing row
    // through Trial.paymentId, which is only set at capture (#1591 J4-P1-06),
    // so the reuse read happens here, off the held appointment.
    const live = await prisma.payment.findFirst({
      where: {
        appointmentId: trial.appointment.id,
        userId: trial.consulteeProfile.userId,
        paymentStatus: PaymentStatus.PENDING,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, paymentIntent: true },
    });

    const intent = live
      ? { paymentIntentId: live.paymentIntent, checkoutUrl: live.paymentIntent }
      : await createApprovalPaymentIntent({
          userId: trial.consulteeProfile.userId,
          appointmentType: "TRIAL",
          trialId: trial.id,
          appointmentId: trial.appointment.id,
          planId: trial.subscriptionPlanId,
          paymentGateway: PaymentGateway.RAZORPAY,
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
        });

    const persisted = await persistTrialPayLink({
      trialId: trial.id,
      paymentIntentId: intent.paymentIntentId,
      checkoutUrl: intent.checkoutUrl,
    });
    return persisted ? intent.checkoutUrl : null;
  } catch (error) {
    reportSentryError(error, {
      subsystem: "trials",
      op: "trial-pay-link-remint",
      extra: { trialId: trial.id },
    });
    return null;
  }
}
