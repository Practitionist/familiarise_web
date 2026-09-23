import { NextRequest } from "next/server";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { remindPaymentResponse } from "@/lib/booking/remind-payment";

/**
 * POST /api/bookings/subscriptions/[subscriptionId]/remind (#1775)
 *
 * The subscription twin of the consultation route: the live pay link is
 * re-sent once per 24 h per appointment; 200 `{ nextAllowedAt }` or 429
 * `{ code: "REMIND_RATE_LIMITED", nextAllowedAt }`.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const { subscriptionId } = await params;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const rl = await applyRateLimit(eventMutationLimiter, auth.session.user.id);
  if (rl) return rl;
  return remindPaymentResponse("subscription", subscriptionId, {
    userId: auth.session.user.id,
    consultantProfileId: auth.session.user.consultantProfileId,
    privileged: isPrivileged(auth.session.user.role),
  });
}
