import { NextResponse } from "next/server";
import { AppointmentStatus, PaymentStatus, type Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { forbiddenResponse } from "@/lib/auth-helpers";
import { BookingRuleError } from "./booking-rule-error";
import { BEING_MOVED } from "@/lib/data/needs-you";
import {
  stageNoticesForAppointmentHolds,
  type StagedBackupInterestNotices,
} from "./backup-interest";
import { transitionParticipant } from "./participants";
import { declineOpenReschedules } from "./reschedule-decline";
import { transitionOccurrenceCompletion } from "./transitions";
import { BookingLockUnavailableError } from "@/utils/appointmentlock";

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
export { APPROVAL_STATUSES_DETAIL_ONLY };

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
 * The answer when the approval lock is not granted: a lock-service outage is
 * its typed 503; anything else the lock raises is contention with another approval.
 */
export function approvalLockRefusal(error: unknown): NextResponse {
  if (error instanceof BookingLockUnavailableError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus },
    );
  }
  if (!(error instanceof Error)) throw error;
  return NextResponse.json({ error: error.message }, { status: 409 });
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
 * The status PATCH answers requests only. A booking being moved (an open
 * reschedule, or released sessions not yet re-placed) is answered through
 * respond / withdraw, re-placed through the allocator, or ended through
 * Cancel — never declined or approved here. A friendly 409 before the write;
 * the write itself also carries `NOT_BEING_MOVED` in its CAS WHERE.
 */
export async function assertNotBeingMoved(
  tx: Tx,
  where: { consultationId: string } | { subscriptionId: string },
  intent: "decline" | "approve",
): Promise<void> {
  const held = await tx.appointment.findFirst({
    where: { ...where, deletedAt: null },
    select: {
      rescheduleRequests: {
        where: { status: "PENDING_REVIEW" },
        select: { id: true },
        take: 1,
      },
      occurrences: {
        where: {
          isTentative: true,
          completionStatus: "RESCHEDULED",
          deletedAt: null,
        },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!held) return;
  if (held.rescheduleRequests.length > 0) {
    throw new BookingRuleError(
      "USE_RESCHEDULE_RESPOND",
      intent === "decline"
        ? "This booking is being moved, not requested. Keep the original time or answer the new one instead."
        : "This booking is being moved. Accept the new time from the request instead.",
    );
  }
  if (held.occurrences.length > 0) {
    throw intent === "decline"
      ? new BookingRuleError(
          "USE_CANCEL_ENDPOINT",
          "This booking was already confirmed. Place a new time, or cancel it to refund the client.",
        )
      : new BookingRuleError(
          "PLACE_RELEASED_SESSIONS",
          "Some sessions were released and need a new time. Place them from the booking instead.",
        );
  }
}

/** The status-PATCH CAS clause: never write a booking that is being moved. */
export const NOT_BEING_MOVED = {
  NOT: { appointment: BEING_MOVED },
} satisfies Prisma.ConsultationWhereInput & Prisma.SubscriptionWhereInput;

/**
 * Release any tentative appointment occurrences, participant seats, open
 * reschedule proposals, and pending payment rows held by a declined request.
 */
export async function releaseDeclinedRequestHold(
  tx: Tx,
  where: { consultationId: string } | { subscriptionId: string },
  actorUserId?: string | null,
): Promise<StagedBackupInterestNotices> {
  const held = await tx.appointment?.findFirst?.({
    where: { ...where, deletedAt: null },
    select: { id: true },
  });
  if (!held) return { bells: [], emails: [] };
  const holdNotices = await stageNoticesForAppointmentHolds(tx, held.id);
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
  return holdNotices ?? { bells: [], emails: [] };
}
