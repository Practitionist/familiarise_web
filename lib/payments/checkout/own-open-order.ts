// What the buyer's own open order for the item a checkout page shows still
// holds, so the page offers the credit and code that checkout pricing counts.

import prisma from "@/lib/prisma";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import type { CheckoutInput } from "@/schemas/checkout";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import {
  openOrderTargetOf,
  ownOpenOrderHolds,
} from "@/lib/payments/checkout/order-reuse";
import { resolveSubscriptionCheckoutPeriod } from "@/lib/payments/checkout/renewal";

const NOTHING_HELD = { creditsPaise: 0, discountCodeIds: [] as string[] };

/**
 * The holds of the buyer's own open order for this checkout's item, matched
 * exactly as checkout pricing matches it; nothing when no item resolves.
 */
export async function ownOpenOrderHoldsForCheckout(
  userId: string,
  input: CheckoutInput,
): Promise<{ creditsPaise: number; discountCodeIds: string[] }> {
  return prisma.$transaction(async (tx) => {
    let period: { startsAt: Date; endsAt: Date } | null = null;
    if (input.appointmentType === "SUBSCRIPTION") {
      const plan = await tx.subscriptionPlan.findUnique({
        where: { id: input.planId },
        select: {
          id: true,
          sessionsPerWeek: true,
          durationInMonths: true,
          consultantProfile: {
            select: { user: { select: { timezone: true } } },
          },
        },
      });
      const consultee = await tx.consulteeProfile.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!plan || !consultee) return NOTHING_HELD;
      try {
        period = await resolveSubscriptionCheckoutPeriod(tx, {
          schedulingPeriodStartsAt: input.schedulingPeriodStartsAt,
          renewsSubscriptionId: input.renewsSubscriptionId,
          consulteeProfileId: consultee.id,
          plan,
          schedulingTimezone: resolveSchedulingTimezone(
            plan.consultantProfile?.user?.timezone,
          ),
        });
      } catch (error) {
        // A start checkout would refuse prices nothing; any other failure reaches the route.
        if (error instanceof BookingRuleError) return NOTHING_HELD;
        throw error;
      }
    }
    const target = openOrderTargetOf(
      input,
      userId,
      input.organizationId ?? null,
      period,
    );
    return target ? ownOpenOrderHolds(tx, target) : NOTHING_HELD;
  });
}
