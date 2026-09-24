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
import { reportSentryError } from "@/lib/observability/report";
import { reconcileOrphanedPayLink } from "@/lib/booking/pay-link-persist";
import { createApprovalPaymentIntent } from "@/lib/payments/operations/approval-payment";
import { payLinkHref } from "@/lib/payments/pay-link-href";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";

/**
 * Persist a freshly minted pay-link only onto the trial that is still waiting
 * for one. Zero rows means the trial moved (cancelled by the sweep, paid, or a
 * concurrent mint won) between the mint and this write; the orphaned order is
 * then tombstoned and reported (reconcileOrphanedPayLink). Returns the link
 * the consultee may use now, or null when the trial is no longer payable.
 * Never throws on the lost race.
 */
export async function persistTrialPayLink(args: {
  trialId: string;
  paymentIntentId: string;
  paymentId: string;
  checkoutUrl: string;
}): Promise<string | null> {
  // #1775 P-1 — a Razorpay "link" is the order id; store our pay page instead.
  const link =
    payLinkHref({ paymentId: args.paymentId, checkoutUrl: args.checkoutUrl }) ??
    args.checkoutUrl;
  // #1775 C-7 — a paid trial is payable from request (PENDING, uncaptured).
  const res = await prisma.trial.updateMany({
    where: {
      id: args.trialId,
      status: { in: TRIAL_PAYABLE_STATUSES },
      paymentId: null,
      pendingPaymentUrl: null,
    },
    data: { pendingPaymentUrl: link },
  });
  if (res.count === 1) return link;
  const outcome = await reconcileOrphanedPayLink({
    kind: "trial",
    id: args.trialId,
    paymentIntentId: args.paymentIntentId,
    checkoutUrl: link,
  });
  return outcome.url;
}

/** #1775 C-7 — a paid trial is payable while PENDING (charged at request) or AWAITING_PAYMENT. */
export const TRIAL_PAYABLE_STATUSES: TrialStatus[] = [
  TrialStatus.PENDING,
  TrialStatus.AWAITING_PAYMENT,
];

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
    TRIAL_PAYABLE_STATUSES.includes(trial.status) &&
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
  // #1775 C-7 — a request-time placeholder has no session yet.
  const slot = trial.appointment?.occurrences[0];
  if (!trial.appointment) return null;
  const appointmentId = trial.appointment.id;

  try {
    // The appointment atom serialises two consultee reads racing here; it is
    // ordered before the mint atom createApprovalPaymentIntent takes itself,
    // so the mint is nested underneath exactly as on the accept path.
    return await withAppointmentLock(appointmentId, async () => {
      // Re-read inside the lock: the read that decided to re-mint may be stale.
      const fresh = await prisma.trial.findUnique({
        where: { id: trial.id },
        select: { status: true, pendingPaymentUrl: true, paymentDueAt: true },
      });
      if (!fresh) return null;
      if (!needsTrialPayLinkRemint(fresh)) return fresh.pendingPaymentUrl;

      const now = new Date();
      // The trial arm of createApprovalPaymentIntent resolves an existing row
      // through Trial.paymentId, which is only set at capture (#1591 J4-P1-06),
      // so the reuse read happens here, off the held appointment. Razorpay
      // only: every trial mint in this codebase pins that gateway (#1165).
      const live = await prisma.payment.findFirst({
        where: {
          appointmentId,
          userId: trial.consulteeProfile.userId,
          paymentGateway: PaymentGateway.RAZORPAY,
          paymentStatus: PaymentStatus.PENDING,
          deletedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, paymentIntent: true },
      });

      const intent = live
        ? {
            paymentIntentId: live.paymentIntent,
            paymentId: live.id,
            checkoutUrl: live.paymentIntent,
          }
        : await createApprovalPaymentIntent({
            userId: trial.consulteeProfile.userId,
            appointmentType: "TRIAL",
            trialId: trial.id,
            appointmentId,
            planId: trial.subscriptionPlanId,
            paymentGateway: PaymentGateway.RAZORPAY,
            startsAt: slot?.startsAt.toISOString(),
            endsAt: slot?.endsAt.toISOString(),
          });

      return persistTrialPayLink({
        trialId: trial.id,
        paymentIntentId: intent.paymentIntentId,
        paymentId: intent.paymentId,
        checkoutUrl: intent.checkoutUrl,
      });
    });
  } catch (error) {
    // Another mutation holds the appointment, or the lock service is down:
    // the next read tries again; both are modelled, not faults.
    const expected =
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError;
    reportSentryError(error, {
      subsystem: "trials",
      op: "trial-pay-link-remint",
      expected,
      extra: { trialId: trial.id },
    });
    return null;
  }
}
