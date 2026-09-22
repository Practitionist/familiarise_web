import { NextRequest, NextResponse } from "next/server";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { refuseMalformedEventId } from "@/lib/booking/request-route-guards";
import { apiError } from "@/lib/errors";
import { withAppointmentLock } from "@/utils/appointmentlock";
import { withdrawApproval } from "@/lib/booking/lapse-approved-request";

/**
 * POST /api/bookings/subscriptions/[subscriptionId]/withdraw-approval (#1775)
 *
 * The subscription twin of the consultation route: the consultant's
 * `APPROVED_PENDING_PAYMENT → EXPIRED` by CAS; 200 `{ status: "EXPIRED" }`
 * or 409 `REQUEST_CHANGED_ELSEWHERE`.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const { subscriptionId } = await params;
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const malformedId = refuseMalformedEventId(subscriptionId);
    if (malformedId) return malformedId;
    const rl = await applyRateLimit(eventMutationLimiter, auth.session.user.id);
    if (rl) return rl;
    const body = await withdrawApproval({
      kind: "subscription",
      id: subscriptionId,
      actor: {
        userId: auth.session.user.id,
        consultantProfileId: auth.session.user.consultantProfileId,
        privileged: isPrivileged(auth.session.user.role),
      },
      lock: withAppointmentLock,
    });
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError({ tag: "[Bookings.subscription.WithdrawApproval]", error });
  }
}
