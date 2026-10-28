import type { Prisma } from "@prisma/client";

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
