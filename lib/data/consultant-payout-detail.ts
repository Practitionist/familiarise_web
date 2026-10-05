/**
 * One payout, as the consultant it pays reads it: the TDS walk, the status
 * timeline, the UTR once COMPLETED and the earnings it settled.
 *
 * The consultant profile id is in the payout's WHERE (and the earnings'), so a
 * payout of another consultant reads as null. The page binds the profile to the
 * session first (requirePersonalProfileAccess).
 */

import type { Currency, PayoutMethod, PayoutStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import { sanitizePayoutFailure } from "@/lib/dashboard/earnings-state";
import {
  RECOVERY_RELEASING_STATUSES,
  clawbackRecoveredPaise,
} from "@/lib/payments/payouts/clawback-recovery";

export interface PayoutTimelineStep {
  label: string;
  at: Date | null;
}

export interface ConsultantPayoutDetail {
  id: string;
  status: PayoutStatus;
  method: PayoutMethod;
  currency: Currency;
  amountPaise: number;
  tdsPaise: number;
  tdsRateBps: number | null;
  tdsFinancialYear: string | null;
  /** An earlier payout's clawback netted from this one; 0 when none stands. */
  recoveredPaise: number;
  netPaise: number;
  /** Set only for a COMPLETED payout. */
  utr: string | null;
  /** Plain words, never the gateway's raw text. */
  failure: string | null;
  createdAt: Date;
  processedAt: Date | null;
  timeline: PayoutTimelineStep[];
  earnings: {
    id: string;
    paymentDate: Date;
    offering: string;
    grossPaise: number;
    sharePaise: number;
  }[];
}

const planTitle = { select: { title: true } } as const;

const FINAL_STEP: Partial<Record<PayoutStatus, string>> = {
  PROCESSING: "Sent to your bank",
  COMPLETED: "Paid",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  REVERSED: "Returned by your bank",
};

export async function readConsultantPayoutDetail(args: {
  payoutId: string;
  consultantProfileId: string;
}): Promise<ConsultantPayoutDetail | null> {
  const { payoutId, consultantProfileId } = args;
  const payout = await prisma.consultantPayout.findFirst({
    where: { id: payoutId, consultantProfileId },
    select: {
      id: true,
      status: true,
      method: true,
      currency: true,
      amount: true,
      tdsDeducted: true,
      netAmount: true,
      tdsRateAppliedBps: true,
      tdsFinancialYear: true,
      gatewayUtr: true,
      failureReason: true,
      createdAt: true,
      approvedAt: true,
      processedAt: true,
      updatedAt: true,
      earnings: {
        where: { consultantProfileId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          grossAmount: true,
          consultantSharePaise: true,
          payment: {
            select: {
              createdAt: true,
              capturedAt: true,
              description: true,
              appointment: {
                select: {
                  consultation: {
                    select: { consultationPlan: planTitle },
                  },
                  subscription: {
                    select: { subscriptionPlan: planTitle },
                  },
                  webinar: { select: { webinarPlan: planTitle } },
                  class: { select: { classPlan: planTitle } },
                  trial: { select: { subscriptionPlan: planTitle } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!payout) return null;
  const recoveredPaise = RECOVERY_RELEASING_STATUSES.includes(payout.status)
    ? 0
    : await clawbackRecoveredPaise(prisma, payout.id);

  const timeline: PayoutTimelineStep[] = [
    { label: "Queued", at: payout.createdAt },
  ];
  if (payout.approvedAt) {
    timeline.push({ label: "Approved", at: payout.approvedAt });
  }
  const final = FINAL_STEP[payout.status];
  if (final) {
    timeline.push({
      label: final,
      at: payout.processedAt ?? payout.updatedAt,
    });
  }

  return toPlain({
    id: payout.id,
    status: payout.status,
    method: payout.method,
    currency: payout.currency,
    amountPaise: payout.amount,
    tdsPaise: payout.tdsDeducted,
    tdsRateBps: payout.tdsRateAppliedBps,
    tdsFinancialYear: payout.tdsFinancialYear,
    recoveredPaise,
    netPaise:
      payout.netAmount ?? payout.amount - payout.tdsDeducted - recoveredPaise,
    utr: payout.status === "COMPLETED" ? payout.gatewayUtr : null,
    failure:
      payout.status === "FAILED"
        ? sanitizePayoutFailure(payout.failureReason)
        : null,
    createdAt: payout.createdAt,
    processedAt: payout.processedAt,
    timeline,
    earnings: payout.earnings.map((e) => {
      const a = e.payment.appointment;
      return {
        id: e.id,
        paymentDate: e.payment.capturedAt ?? e.payment.createdAt,
        offering:
          a?.consultation?.consultationPlan?.title ??
          a?.subscription?.subscriptionPlan?.title ??
          a?.webinar?.webinarPlan?.title ??
          a?.class?.classPlan?.title ??
          a?.trial?.subscriptionPlan?.title ??
          e.payment.description ??
          "Payment",
        grossPaise: e.grossAmount,
        sharePaise: e.consultantSharePaise,
      };
    }),
  });
}
