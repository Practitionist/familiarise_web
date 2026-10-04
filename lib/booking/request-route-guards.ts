import { NextResponse } from "next/server";
import { AppointmentStatus, PaymentStatus } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { forbiddenResponse } from "@/lib/auth-helpers";
import { stageNoticesForAppointmentHolds } from "./backup-interest";
import { transitionParticipant } from "./participants";
import { declineOpenReschedules } from "./reschedule-decline";
import { transitionOccurrenceCompletion } from "./transitions";

import {
  EVENT_ID_INVALID_MESSAGE,
  isEventIdFormat,
} from "@/schemas/slotAllocation/validationSchemas";
import {
  APPROVAL_STATUSES_DETAIL_ONLY,
  USE_DETAIL_APPROVAL_MESSAGE,
  parseRequestListQuery,
  type RequestListQuery,
} from "./list-query";

/**
 * The response halves of the #1704 guards, shared by the consultation and
 * subscription request routes so each rule has one body. Server-only:
 * lib/booking/list-query.ts stays importable from the client tab.
 */

export function parseRequestListQueryOrRespond(
  searchParams: URLSearchParams,
):
  | { query: RequestListQuery; response: null }
  | { query: null; response: NextResponse } {
  const parsed = parseRequestListQuery(searchParams);
  if (!parsed.ok) {
    return {
      query: null,
      response: NextResponse.json(
        { error: parsed.error, code: parsed.code },
        { status: 400 },
      ),
    };
  }
  return { query: parsed.query, response: null };
}

/**
 * 400 VALIDATION_ERROR for a path id that is not a UUID/CUID, so no read
 * (including the authz lookup) ever runs on an arbitrary string.
 */
export function refuseMalformedEventId(id: string): NextResponse | null {
  if (isEventIdFormat(id)) return null;
  return NextResponse.json(
    { error: EVENT_ID_INVALID_MESSAGE, code: "VALIDATION_ERROR" },
    { status: 400 },
  );
}

/** 409 USE_DETAIL_APPROVAL for a status only the `[id]` PATCH may write. */
export function refuseApprovalOnListRoute(
  status: AppointmentStatus,
): NextResponse | null {
  if (!APPROVAL_STATUSES_DETAIL_ONLY.has(status)) return null;
  return NextResponse.json(
    { error: USE_DETAIL_APPROVAL_MESSAGE, code: "USE_DETAIL_APPROVAL" },
    { status: 409 },
  );
}

/**
 * Shared guard for `PATCH /api/bookings/{consultations,subscriptions}` list
 * endpoints: only `REJECTED` (by the consultant or privileged actor) is legal.
 */
export function validateListRequestStatusPatch(
  status: AppointmentStatus,
  isConsultant: boolean,
  isPrivilegedActor: boolean,
): NextResponse | null {
  const approvalRefusal = refuseApprovalOnListRoute(status);
  if (approvalRefusal) return approvalRefusal;

  if (
    status === AppointmentStatus.REJECTED &&
    !isConsultant &&
    !isPrivilegedActor
  ) {
    return forbiddenResponse(
      "Only the consultant can decline a request. Cancel it instead.",
    );
  }

  if (status === AppointmentStatus.CANCELLED) {
    return NextResponse.json(
      {
        error:
          "Cancelling bookings via status PATCH is not supported. Use POST /api/appointments/{appointmentId}/cancel instead.",
        code: "USE_CANCEL_ENDPOINT",
      },
      { status: 400 },
    );
  }

  if (status !== AppointmentStatus.REJECTED) {
    return NextResponse.json(
      {
        error:
          "Only REJECTED status transitions are permitted on this endpoint.",
        code: "UNSUPPORTED_STATUS_PATCH",
      },
      { status: 400 },
    );
  }

  return null;
}

/**
 * Shared guard for `PATCH /api/bookings/{consultations,subscriptions}/[id]`
 * detail endpoints: only `APPROVED` and `REJECTED` (by the consultant or
 * privileged actor, and never self-approved) are legal.
 */
export function validateDetailRequestStatusPatch(
  status: AppointmentStatus,
  isConsultant: boolean,
  isPrivilegedActor: boolean,
  isSelfApproval: boolean,
): NextResponse | null {
  if (
    APPROVAL_STATUSES_DETAIL_ONLY.has(status) &&
    isSelfApproval &&
    !isPrivilegedActor
  ) {
    return NextResponse.json(
      { error: "You cannot approve your own request", code: "SELF_APPROVAL" },
      { status: 403 },
    );
  }

  if (
    status === AppointmentStatus.REJECTED &&
    !isConsultant &&
    !isPrivilegedActor
  ) {
    return forbiddenResponse(
      "Only the consultant can decline a request. Cancel it instead.",
    );
  }

  if (
    status === AppointmentStatus.APPROVED &&
    !isConsultant &&
    !isPrivilegedActor
  ) {
    return forbiddenResponse("Only the consultant can approve a request.");
  }

  if (status === AppointmentStatus.CANCELLED) {
    return NextResponse.json(
      {
        error:
          "Cancelling bookings via status PATCH is not supported. Use POST /api/appointments/{appointmentId}/cancel instead.",
        code: "USE_CANCEL_ENDPOINT",
      },
      { status: 400 },
    );
  }

  if (
    status !== AppointmentStatus.APPROVED &&
    status !== AppointmentStatus.REJECTED
  ) {
    return NextResponse.json(
      {
        error:
          "Only APPROVED and REJECTED status transitions are permitted on this endpoint.",
        code: "UNSUPPORTED_STATUS_PATCH",
      },
      { status: 400 },
    );
  }

  return null;
}

/**
 * Release any tentative appointment occurrences, participant seats, open
 * reschedule proposals, and pending payment rows held by a declined request.
 */
export async function releaseDeclinedRequestHold(
  tx: Tx,
  where: { consultationId: string } | { subscriptionId: string },
  actorUserId?: string | null,
): Promise<void> {
  const held = await tx.appointment?.findFirst?.({
    where: { ...where, deletedAt: null },
    select: { id: true },
  });
  if (!held) return;
  await stageNoticesForAppointmentHolds(tx, held.id);
  await transitionOccurrenceCompletion(tx, {
    actorUserId: actorUserId ?? null,
    reason: "Request declined by consultant",
    where: { appointmentId: held.id, deletedAt: null },
    to: "CANCELLED",
    data: { deletedAt: new Date(), isTentative: false },
    allowZero: true,
  });
  await transitionParticipant(tx, { appointmentId: held.id }, "CANCELLED");
  await declineOpenReschedules(tx, held.id, {
    actorUserId: actorUserId ?? null,
    reason: "Request declined by consultant",
  });
  await tx.payment?.updateMany?.({
    where: { appointmentId: held.id, paymentStatus: PaymentStatus.PENDING },
    data: { paymentStatus: PaymentStatus.EXPIRED },
  });
}

/** What the two PUT routes read off the plan a `planId` names. */
export interface PlanOwnership {
  consultantProfileId: string;
  organizationId: string | null;
}

/**
 * 403 PLAN_NOT_OWNED unless the plan a PUT names belongs to the request's
 * own consultant, then 403 PLAN_ORG_MISMATCH unless it also sits in the
 * booking's funding org (`bookingOrgId`, plan first then appointment; null
 * is personal, so personal only swaps for personal). `readPlanOwner` is the
 * model-specific lookup.
 */
export async function refusePlanNotOwned(
  planId: string | undefined,
  request: {
    consultantProfileId: string | null | undefined;
    /** `bookingOrgId(existing)` — the org that funds this booking. */
    organizationId: string | null;
  },
  readPlanOwner: () => Promise<PlanOwnership | null>,
): Promise<NextResponse | null> {
  if (!planId) return null;
  const targetPlan = await readPlanOwner();
  if (
    !targetPlan ||
    targetPlan.consultantProfileId !== request.consultantProfileId
  ) {
    return NextResponse.json(
      {
        error: "The plan belongs to a different consultant",
        code: "PLAN_NOT_OWNED",
      },
      { status: 403 },
    );
  }
  // A plan swap that changes the funding org would re-rail the booking's
  // money (#1717 triage #14); the org is fixed at request time.
  if (targetPlan.organizationId !== request.organizationId) {
    return NextResponse.json(
      {
        error: "The plan belongs to a different organisation than this booking",
        code: "PLAN_ORG_MISMATCH",
      },
      { status: 403 },
    );
  }
  return null;
}
