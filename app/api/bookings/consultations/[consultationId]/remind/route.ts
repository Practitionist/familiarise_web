import { NextRequest } from "next/server";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { remindPaymentResponse } from "@/lib/booking/remind-payment";

/**
 * POST /api/bookings/consultations/[consultationId]/remind (#1775)
 *
 * The consultant re-sends the live pay link to a consultee who has not paid
 * an approval yet. Once per 24 h per appointment: 200 `{ nextAllowedAt }`,
 * 429 `{ code: "REMIND_RATE_LIMITED", nextAllowedAt }`, 409
 * `NOT_AWAITING_PAYMENT` when there is no open pay order to remind about.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  const { consultationId } = await params;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const rl = await applyRateLimit(eventMutationLimiter, auth.session.user.id);
  if (rl) return rl;
  return remindPaymentResponse("consultation", consultationId, {
    userId: auth.session.user.id,
    consultantProfileId: auth.session.user.consultantProfileId,
    privileged: isPrivileged(auth.session.user.role),
  });
}
