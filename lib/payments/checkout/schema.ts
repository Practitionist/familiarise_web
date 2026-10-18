// Checkout's result shapes and the gateway `notes` payload shared by intent
// creation and the capture webhook.

import type { CheckoutInput } from "@/schemas/checkout";
import { Prisma } from "@prisma/client";

/**
 * Unified return type for subscription checkout
 * FIX Issue #2: Creates placeholder appointment for payment linkage
 * This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
 * Consultant allocates specific slots later via Requests tab
 */
export type SubscriptionCheckoutResult = {
  // #780 — extended-client reads return price/trialPriceInPaise as number;
  // GetPayload says bigint.
  plan: Omit<
    Prisma.SubscriptionPlanGetPayload<{
      include: {
        consultantProfile: {
          include: { user: true };
        };
      };
    }>,
    "price" | "trialPriceInPaise"
  > & { price: number; trialPriceInPaise: number };
  amount: number;
  subscription: Prisma.SubscriptionGetPayload<Record<string, never>>;
  appointment: Prisma.AppointmentGetPayload<Record<string, never>>;
  isSchedulingPeriodRequest: boolean;
};

/**
 * #1437 — Razorpay caps an order's `notes` at 15 keys and 256 characters per
 * value, and this object is that payload (Stripe's own limits are far looser,
 * so the tighter gateway sets the shape for both).
 *
 * Two consequences are handled here. The buyer's booking note is truncated
 * rather than forwarded verbatim: `checkoutSchema` already rejects anything
 * longer, and the full text is persisted on the Payment and Appointment rows,
 * so this copy exists only for the gateway dashboard and losing its tail costs
 * nothing — whereas exceeding the limit costs the buyer the whole purchase.
 * And `discountCode` was dropped: the org-sponsored event case emitted exactly
 * 15 keys, leaving no headroom for the next one, and the discount is already
 * reflected in the order amount and recorded on the Payment row, while nothing
 * in the webhook path ever reads it back out of the gateway.
 *
 * #1462 — an optional field with no value is omitted rather than emitted as an
 * empty string, because the webhook schemas type those fields as `.optional()`,
 * which admits an absent key but rejects `""`; sending the empty key made every
 * scheduling-period subscription fail validation at capture, and it also spent
 * key budget the 15-key ceiling above has no room for.
 */
export const GATEWAY_NOTE_MAX_CHARS = 256;

/**
 * Build payment metadata for both payment intents and webhook handlers
 * Ensures consistency between payment creation and mock payment flows.
 *
 * When the booking is org-sponsored, `organizationId` and `fundingSource`
 * are stamped into the gateway's `notes` (C.1, #687). This lets the
 * webhook attribute the payment to the org without an extra DB lookup
 * and gives invoice-fraud reconcilers a server-side proof that the
 * booker's claimed org matches the gateway's record.
 */
export function buildPaymentMetadata(
  data: CheckoutInput,
  userId: string,
  orgContext?: {
    organizationId: string | null;
    fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE" | null;
  },
): { appointmentId: string; appointmentType: string; [key: string]: string } {
  const notes = (data.notes || "").slice(0, GATEWAY_NOTE_MAX_CHARS);
  return {
    appointmentId: "pending",
    appointmentType: data.appointmentType,
    userId: userId,
    planId: data.planId,
    // #1462 — every key below is conditional. A scheduling-period subscription
    // carries no direct slots, so `startsAt`/`endsAt` used to reach the gateway
    // as `""` and then failed `z.string().datetime().optional()` on the way
    // back in, stranding a captured sale as REQUIRES_MANUAL_RECOVERY.
    ...(data.startsAt && { startsAt: data.startsAt }),
    ...(data.endsAt && { endsAt: data.endsAt }),
    ...(data.availabilityWindowWeeklyId && {
      availabilityWindowWeeklyId: data.availabilityWindowWeeklyId,
    }),
    ...(data.availabilityWindowCustomId && {
      availabilityWindowCustomId: data.availabilityWindowCustomId,
    }),
    ...(data.schedulingPeriodStartsAt && {
      schedulingPeriodStartsAt: data.schedulingPeriodStartsAt,
    }),
    ...(data.schedulingPeriodEndsAt && {
      schedulingPeriodEndsAt: data.schedulingPeriodEndsAt,
    }),
    ...(notes && { notes }),
    ...(data.eventId && { eventId: data.eventId }),
    ...(orgContext?.organizationId && {
      organizationId: orgContext.organizationId,
    }),
    ...(orgContext?.fundingSource && {
      fundingSource: orgContext.fundingSource,
    }),
  };
}
