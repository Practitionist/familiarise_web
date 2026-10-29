import type { Prisma } from "@prisma/client";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";

/**
 * A direct checkout is the buyer's own purchase in flight, not a request: it
 * becomes something the consultant answers only once a payment on its wrapper
 * has succeeded (a paid plan still needs its first cycle placed).
 */
const SUCCEEDED = { paymentStatus: "SUCCEEDED" } as const;

export const ANSWERABLE_CONSULTATION = {
  OR: [
    { bookingSource: { not: "DIRECT_CHECKOUT" } },
    { appointment: { payment: { some: SUCCEEDED } } },
  ],
} satisfies Prisma.ConsultationWhereInput;

export const ANSWERABLE_SUBSCRIPTION = {
  OR: [
    { bookingSource: { not: "DIRECT_CHECKOUT" } },
    { appointment: { payment: { some: SUCCEEDED } } },
  ],
} satisfies Prisma.SubscriptionWhereInput;

/** An unpaid direct checkout whose pay window is still open at `now`. */
export function liveCheckoutHold(now: Date) {
  return {
    bookingSource: "DIRECT_CHECKOUT",
    appointment: {
      payment: {
        some: { paymentStatus: "PENDING", expiresAt: { gt: now } },
        none: SUCCEEDED,
      },
    },
  } satisfies Prisma.ConsultationWhereInput & Prisma.SubscriptionWhereInput;
}

/** The refusal for answering a booking whose buyer is still paying for it. */
export function checkoutInProgressError(): BookingRuleError {
  return new BookingRuleError(
    "CHECKOUT_IN_PROGRESS",
    "This client is still paying — try again in a few minutes.",
  );
}

/** Whether these wrapper payments are a direct checkout still being paid at `now`. */
export function isLiveCheckoutHold(
  bookingSource: string | null | undefined,
  payments: ReadonlyArray<{ paymentStatus: string; expiresAt: Date | null }>,
  now: Date,
): boolean {
  return (
    bookingSource === "DIRECT_CHECKOUT" &&
    !payments.some((p) => p.paymentStatus === "SUCCEEDED") &&
    payments.some(
      (p) =>
        p.paymentStatus === "PENDING" &&
        p.expiresAt !== null &&
        p.expiresAt > now,
    )
  );
}

type HoldCounters = {
  consultation: {
    count: (args: { where: Prisma.ConsultationWhereInput }) => Promise<number>;
  };
  subscription: {
    count: (args: { where: Prisma.SubscriptionWhereInput }) => Promise<number>;
  };
};

/** Refuses (409 CHECKOUT_IN_PROGRESS) while the buyer's own checkout is still live. */
export async function assertNoLiveCheckoutHold(
  db: HoldCounters,
  kind: "consultation" | "subscription",
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const where = { id, ...liveCheckoutHold(now) };
  const live =
    kind === "consultation"
      ? await db.consultation.count({ where })
      : await db.subscription.count({ where });
  if (live > 0) throw checkoutInProgressError();
}
