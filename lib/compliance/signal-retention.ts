import type { Prisma, ReferralStatus } from "@prisma/client";
import { yearsBefore } from "@/lib/cron/retention-cutoff";

const DAY_MS = 86_400_000;

/** Referral request signals are review evidence only until 180 days after the referral is terminal. */
export const REFERRAL_SIGNAL_RETENTION_DAYS = 180;
/** Payer instrument hashes serve the self-referral and chargeback checks for two years after capture. */
export const PAYER_SIGNAL_RETENTION_YEARS = 2;

/** The values `scrubUser` and the retention job write over the referral request signals. */
export const NULLED_REFERRAL_SIGNALS = {
  ipHash: null,
  userAgent: null,
} satisfies Prisma.ReferralUpdateManyMutationInput;

export const NULLED_PAYER_SIGNALS = {
  payerVpaHash: null,
  payerPhoneHash: null,
} satisfies Prisma.PaymentUpdateManyMutationInput;

/** Terminal statuses that record no timestamp of their own, so `updatedAt` stands in for the transition. */
const UNDATED_TERMINAL: ReferralStatus[] = [
  "VOID",
  "REWARDED",
  "EXPIRED",
  "FRAUDULENT",
];

/** Terminal referrals, past the retention window, that still hold a request signal. */
export function referralSignalPruneWhere(
  now: number,
): Prisma.ReferralWhereInput {
  const cutoff = new Date(now - REFERRAL_SIGNAL_RETENTION_DAYS * DAY_MS);
  return {
    AND: [
      { OR: [{ ipHash: { not: null } }, { userAgent: { not: null } }] },
      {
        OR: [
          { status: "VESTED", vestedAt: { lt: cutoff } },
          { status: { in: UNDATED_TERMINAL }, updatedAt: { lt: cutoff } },
        ],
      },
    ],
  };
}

/** Payments captured more than two years ago that still hold a payer instrument hash. */
export function paymentSignalPruneWhere(now: number): Prisma.PaymentWhereInput {
  const cutoff = yearsBefore(now, PAYER_SIGNAL_RETENTION_YEARS);
  return {
    AND: [
      {
        OR: [
          { payerVpaHash: { not: null } },
          { payerPhoneHash: { not: null } },
        ],
      },
      {
        OR: [
          { capturedAt: { lt: cutoff } },
          { capturedAt: null, createdAt: { lt: cutoff } },
        ],
      },
    ],
  };
}
