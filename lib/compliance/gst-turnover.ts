/**
 * The GST registration alarm for the unregistered regime, run by the daily ops
 * digest. As principal supplier every sale is the platform's own turnover, so
 * it reads the current financial year's captured payments, net of refunds, and
 * reports once when they near the CGST s.22 threshold.
 */

import type { Prisma } from "@prisma/client";

import type { Db } from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";
import { reportSentryMessage } from "@/lib/observability/report";
import { istFinancialYearStart } from "@/lib/compliance/ist-period";

/** CGST s.22 aggregate-turnover threshold for a services supplier: ₹20,00,000. */
export const GST_REGISTRATION_THRESHOLD_PAISE = 200_000_000;

/** Alarm at ₹15,00,000, leaving room for the roughly 7 working days a registration takes. */
export const GST_TURNOVER_ALARM_PAISE = 150_000_000;

export interface GstTurnoverCheck {
  financialYearStart: Date;
  /** Charged less GST and succeeded refunds, plus referral credits still spent after restores. */
  turnoverPaise: number;
  alarmed: boolean;
}

/**
 * Real (non-mock) succeeded payments sold in the current financial year: by capture
 * time, else creation time for rails confirmed at checkout. A re-mint resets capturedAt.
 */
function financialYearPaymentWhere(financialYearStart: Date) {
  return {
    paymentStatus: "SUCCEEDED",
    deletedAt: null,
    isMockPayment: false,
    OR: [
      { capturedAt: { gte: financialYearStart } },
      { capturedAt: null, createdAt: { gte: financialYearStart } },
    ],
  } satisfies Prisma.PaymentWhereInput;
}

/** The current financial year's turnover; one Sentry message when it crosses the alarm. */
export async function checkGstRegistrationTurnover(
  db: Db,
  now: Date = new Date(),
): Promise<GstTurnoverCheck> {
  const financialYearStart = istFinancialYearStart(now);
  const paymentWhere = financialYearPaymentWhere(financialYearStart);
  // PG_POOL_MAX=1: one statement at a time.
  const charged = await db.payment.aggregate({
    where: paymentWhere,
    _sum: { amount: true, taxAmount: true },
  });
  // Usage rows shrink, or go, as a refund restores credit; the credit leg does not.
  const credits = await db.referralCreditUsage.aggregate({
    where: { payment: paymentWhere },
    _sum: { amount: true },
  });
  const refunded = await db.refund.aggregate({
    where: { status: "SUCCEEDED", payment: paymentWhere },
    _sum: { amountPaise: true },
  });
  const turnoverPaise =
    sumPaise(charged._sum.amount) -
    sumPaise(charged._sum.taxAmount) +
    sumPaise(credits._sum.amount) -
    sumPaise(refunded._sum.amountPaise);
  const alarmed = turnoverPaise >= GST_TURNOVER_ALARM_PAISE;
  if (alarmed) {
    const rupees = (paise: number) =>
      `₹${Math.floor(paise / 100).toLocaleString("en-IN")}`;
    reportSentryMessage(
      `GST registration due: financial-year turnover is ${rupees(turnoverPaise)} while unregistered. ` +
        `Registration is compulsory above ${rupees(GST_REGISTRATION_THRESHOLD_PAISE)} (CGST s.22); apply within 30 days of crossing it and set PLATFORM_GSTIN.`,
      {
        subsystem: "compliance",
        op: "gst-turnover-alarm",
        level: "warning",
        fingerprint: ["gst-registration-turnover-alarm"],
        extra: {
          turnoverPaise,
          financialYearStart: financialYearStart.toISOString(),
        },
      },
    );
  }
  return { financialYearStart, turnoverPaise, alarmed };
}
