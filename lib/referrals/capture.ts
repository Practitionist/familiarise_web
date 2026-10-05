import { Prisma } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { readReferralProgramConfig, recordBudgetSpend } from "./program-config";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sessions that were never delivered and so cannot qualify a referral. */
export const UNDELIVERED_OCCURRENCE_STATUSES = [
  "CANCELLED",
  "RESCHEDULED",
  "VOIDED",
] as const;

/** The first live session of the paid appointment: the one that must be delivered to vest. */
export async function firstLiveOccurrenceId(
  tx: Tx,
  appointmentId: string | null,
): Promise<string | null> {
  if (!appointmentId) return null;
  const occ = await tx.appointmentOccurrence.findFirst({
    where: {
      appointmentId,
      deletedAt: null,
      completionStatus: { notIn: [...UNDELIVERED_OCCURRENCE_STATUSES] },
    },
    orderBy: { startsAt: "asc" },
    select: { id: true },
  });
  return occ?.id ?? null;
}

/**
 * Runs in the capture transaction once the booking is confirmed. A cash-funded sale records
 * who owns the buyer relationship (first writer wins); a referee's first paid marketplace
 * purchase moves to QUALIFYING with the referrer's credit PENDING and its welcome discount
 * metered against the budget; a referred expert's first paid sale moves to QUALIFYING.
 * Nothing here is spendable; the vest sweep decides.
 */
export async function recordReferralCapture(
  tx: Tx,
  input: { paymentId: string; consultantProfileId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const payment = await tx.payment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true,
      userId: true,
      paymentStatus: true,
      appointmentId: true,
      attributionSource: true,
      attributionReferralId: true,
      welcomeDiscountPaise: true,
      legs: { where: { source: "CARD" }, select: { amountPaise: true } },
    },
  });
  if (payment?.paymentStatus !== "SUCCEEDED") return;
  const consultant = await tx.consultantProfile.findUnique({
    where: { id: input.consultantProfileId },
    select: { userId: true },
  });
  if (!consultant || consultant.userId === payment.userId) return;

  // Only a gateway (cash) leg owns a relationship: never a ₹0, credit-only or org-funded sale.
  const cashPaise = payment.legs.reduce((sum, l) => sum + l.amountPaise, 0);
  if (cashPaise > 0) {
    await tx.expertCustomerRelationship.createMany({
      data: [
        {
          consultantProfileId: input.consultantProfileId,
          buyerUserId: payment.userId,
          source: payment.attributionSource ?? "MARKETPLACE",
          firstPaymentId: payment.id,
        },
      ],
      skipDuplicates: true,
    });
  }

  const cfg = await readReferralProgramConfig(tx);
  if (!cfg) return;
  const windowStart = new Date(now.getTime() - cfg.qualifyWindowDays * DAY_MS);
  const qualifying = {
    status: "QUALIFYING" as const,
    qualifiedAt: now,
    qualifyingPaymentId: payment.id,
    qualifyingOccurrenceId: await firstLiveOccurrenceId(
      tx,
      payment.appointmentId,
    ),
  };

  if (
    payment.attributionSource === "CONSUMER_REFERRAL" &&
    payment.attributionReferralId &&
    cashPaise >= cfg.minOrderPaise
  ) {
    const referral = await tx.referral.findUnique({
      where: { id: payment.attributionReferralId },
      select: { id: true, referralCode: { select: { userId: true } } },
    });
    if (referral && referral.referralCode.userId !== consultant.userId) {
      const claimed = await tx.referral.updateMany({
        where: {
          id: referral.id,
          referredUserId: payment.userId,
          status: "SIGNED_UP",
          signedUpAt: { gte: windowStart },
        },
        data: { ...qualifying, qualifyingAction: "first_paid_booking" },
      });
      if (claimed.count === 1) {
        await recordBudgetSpend(tx, payment.welcomeDiscountPaise ?? 0, now);
      }
      if (claimed.count === 1 && cfg.referrerRewardPaise > 0) {
        // A referral reopened after an expert or platform cancellation revives its voided credit.
        const revived = await tx.referralCredit.updateMany({
          where: {
            userId: referral.referralCode.userId,
            referralId: referral.id,
            source: "REFERRAL_BONUS",
            state: "VOID",
            vestedAt: null,
            usedAmount: 0,
          },
          data: {
            state: "PENDING",
            voidedAt: null,
            amount: cfg.referrerRewardPaise,
            remainingAmount: cfg.referrerRewardPaise,
            configVersion: cfg.version,
          },
        });
        if (revived.count === 0) {
          await tx.referralCredit.createMany({
            data: [
              {
                userId: referral.referralCode.userId,
                amount: cfg.referrerRewardPaise,
                remainingAmount: cfg.referrerRewardPaise,
                currency: "INR",
                source: "REFERRAL_BONUS",
                referralId: referral.id,
                state: "PENDING",
                configVersion: cfg.version,
              },
            ],
            skipDuplicates: true,
          });
        }
      }
    }
  }

  if (cashPaise > 0) {
    await tx.referral.updateMany({
      where: {
        referredUserId: consultant.userId,
        status: "SIGNED_UP",
        signedUpAt: { gte: windowStart },
        referralCode: { userId: { not: payment.userId } },
      },
      data: { ...qualifying, qualifyingAction: "first_paid_booking_received" },
    });
  }
}

/**
 * The capture paths' entry: a referral fault must never undo a confirmed booking, so it
 * rolls back to its own savepoint; only a serialization failure retries the whole capture.
 */
export async function recordReferralCaptureInSavepoint(
  tx: Tx,
  input: {
    paymentId: string;
    /** Resolved inside the savepoint so a lookup fault cannot fail the capture. */
    consultantProfileId: () => Promise<string | null | undefined>;
  },
): Promise<void> {
  await tx.$executeRaw`SAVEPOINT sp_referral_capture`;
  try {
    const consultantProfileId = await input.consultantProfileId();
    if (consultantProfileId) {
      await recordReferralCapture(tx, {
        paymentId: input.paymentId,
        consultantProfileId,
      });
    }
    await tx.$executeRaw`RELEASE SAVEPOINT sp_referral_capture`;
  } catch (err) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT sp_referral_capture`.catch(
      () => undefined,
    );
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2034"
    ) {
      throw err;
    }
    reportSentryError(err, {
      subsystem: "referrals",
      op: "recordReferralCapture",
      extra: { paymentId: input.paymentId },
    });
  }
}
