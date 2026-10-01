import { NextRequest, NextResponse } from "next/server";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { refuseMalformedEventId } from "@/lib/booking/request-route-guards";
import { apiError } from "@/lib/errors";
import { withAppointmentLock } from "@/utils/appointmentlock";
import { withdrawApproval } from "@/lib/booking/lapse-approved-request";

/**
 * POST /api/bookings/consultations/[consultationId]/withdraw-approval (#1775)
 *
 * The consultant takes back an approval nobody has paid for:
 * `APPROVED_PENDING_PAYMENT → EXPIRED` by CAS, the held times released, the
 * open pay order tombstoned. 200 `{ status: "EXPIRED" }`, or 409
 * `REQUEST_CHANGED_ELSEWHERE` when a capture moved the request first.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  const { consultationId } = await params;
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const malformedId = refuseMalformedEventId(consultationId);
    if (malformedId) return malformedId;
    const rl = await applyRateLimit(eventMutationLimiter, auth.session.user.id);
    if (rl) return rl;
    const body = await withdrawApproval({
      kind: "consultation",
      id: consultationId,
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
    return apiError({ tag: "[Bookings.consultation.WithdrawApproval]", error });
  }
}
