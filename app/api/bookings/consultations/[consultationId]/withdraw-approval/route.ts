import { NextRequest, NextResponse } from "next/server";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import { refuseMalformedEventId } from "@/lib/booking/request-route-guards";
import { apiError } from "@/lib/errors";
import {
  renewAppointmentLock,
  withAppointmentLock,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import { withdrawApproval } from "@/lib/booking/lapse-approved-request";

/**
 * POST /api/bookings/consultations/[consultationId]/withdraw-approval (#1775)
 *
 * The consultant takes back an approval nobody has paid for:
 * `APPROVED_PENDING_PAYMENT → CANCELLED` by CAS, the held times released, the
 * open pay order tombstoned. 200 `{ status: "CANCELLED" }`, or 409
 * `REQUEST_CHANGED_ELSEWHERE` when a capture moved the request first.
 *
 * The released holds stay released — there is nothing to put back, because an
 * unpaid approval's occurrences were tentative in the first place. CANCELLED and
 * not EXPIRED because a consultant with standing ended a live booking, where
 * EXPIRED is reserved for a pay-link that ran out.
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
      // The retry loop outlives the appointment lock's fixed grant, so each
      // attempt re-grants it — see withdrawApproval.
      //
      // `renewAppointmentLock` answers whether the re-grant succeeded; that is
      // deliberately dropped. A renewal that fails only costs serialisation,
      // because the request CAS below carries the money predicate in its WHERE
      // (see lapseApprovedRequest), so correctness never rests on the lock
      // being held for the whole retry loop.
      //
      // The cast is this route's job, not a shortcut. `RenewInjectedLock` takes
      // `unknown` on purpose — lapse-approved-request must not import the Redis
      // module, or every sweep that shares it stops loading under jsdom. This is
      // the one boundary that has both types in scope.
      renewLock: async (heldLock) => {
        await renewAppointmentLock(
          heldLock as ApprovalLock | null | undefined,
        );
      },
    });
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError({ tag: "[Bookings.consultation.WithdrawApproval]", error });
  }
}
