import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  applyRateLimit,
  eventMutationLimiter,
  rescheduleAppointmentLimiter,
} from "@/lib/rate-limit";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/errors";
import {
  acceptProposal,
  declineProposal,
} from "@/lib/booking/reschedule-respond";
import type { RescheduleRespondCode } from "@/lib/booking/reschedule-proposals";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import { hasActiveDisputeForAppointment } from "@/lib/payments/dispute-guard";
import { isOrgAdminOfAppointment } from "@/lib/booking/org-actor";
import {
  isSuspendedInFundingOrg,
  membershipSuspendedResponse,
} from "@/lib/enterprise/suspended-member-sessions";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import type { EventType } from "@/utils/scheduling-engine/types";

const RespondSchema = z.object({ action: z.enum(["accept", "decline"]) });

/** Why an accept was refused, in the counterparty's words. */
const ACCEPT_FAILURE_COPY: Record<string, string> = {
  NO_PROPOSED_TIMES:
    "This request proposes no concrete times — place times on the calendar instead.",
  PROPOSAL_EXPIRED:
    "This proposal has expired. The released times are back with the consultant to place.",
};
const ACCEPT_FAILURE_FALLBACK = "The proposed times could not be confirmed.";

const DECLINE_OUTCOME_COPY: Record<RescheduleRespondCode, string> = {
  DECLINED:
    "Proposal declined. Your original session times have been put back and stand.",
  RELEASED:
    "Proposal declined. That original time has since been booked, so the consultant will place those sessions at new times.",
};

/**
 * POST /api/appointments/[appointmentId]/reschedule/respond
 *
 * The counterparty answers the open proposal (#1163). Accept re-validates the
 * proposed times through the full allocator; decline ends the request and puts
 * the released slots back where they were, or — when the original time has been
 * taken while the proposal was open — leaves them in the consultant's allocate
 * queue. The initiator's withdraw reaches the same restore.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;
    // #1583 D-P0-02 — fresh, ban-aware read; 401 / 403 / 503 shapes are the helper's.
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;
    // Same budget as the sibling reschedule route: both move slots and money.
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;
    const apptLimited = await applyRateLimit(
      rescheduleAppointmentLimiter,
      `${session.user.id}:${appointmentId}`,
    );
    if (apptLimited) return apptLimited;
    const parsed = RespondSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'action must be "accept" or "decline"' },
        { status: 400 },
      );
    }

    const open = await prisma.rescheduleRequest.findFirst({
      where: {
        appointmentId,
        status: { in: RESCHEDULE_OPEN_STATUSES },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        initiatedById: true,
        // #1846 — the released rows are NOT read here. This route used to
        // recount them to decide the outcome code, which made it a second reader
        // of a decision the module had already committed; the module now reports
        // `restoredFully` and the route only words it.
        appointment: {
          select: {
            consultationId: true,
            subscriptionId: true,
            // #1166 ORG-9 — needed to tell an org admin's initiation from a
            // stranger's (see the side resolution below).
            organizationId: true,
            consultation: {
              select: {
                requestedBy: { select: { userId: true } },
                consultationPlan: {
                  select: { consultantProfile: { select: { userId: true } } },
                },
              },
            },
            subscription: {
              select: {
                requestedBy: { select: { userId: true } },
                subscriptionPlan: {
                  select: { consultantProfile: { select: { userId: true } } },
                },
              },
            },
          },
        },
      },
    });

    // Same anti-oracle discipline as the withdraw route: "no open request",
    // "not a participant" and "you are the initiator" all answer 404, so this
    // route cannot be walked to learn which bookings hold live reschedules.
    // Read each relation on its own rather than casting the union: a cast still
    // compiles when the select shape changes, and would silently drop the
    // consultant from the authorization set.
    const consultation = open?.appointment?.consultation;
    const subscription = open?.appointment?.subscription;
    const consulteeUserId =
      consultation?.requestedBy?.userId ?? subscription?.requestedBy?.userId;
    const consultantUserId =
      consultation?.consultationPlan?.consultantProfile?.userId ??
      subscription?.subscriptionPlan?.consultantProfile?.userId;

    // #1166 ORG-9 — "the counterparty" is the side that did not open the
    // request, and there are three possible openers, not two. An org admin
    // rescheduling a session their organization funded matches NEITHER profile,
    // so the old "is a participant and is not the initiator" test was true for
    // BOTH parties at once: the consultee could accept a proposal made on their
    // own behalf, and either party could answer a request the other had not
    // seen. An org admin acts on the payer's side, so their initiation is a
    // consultee-side initiation and the consultant is the one who answers.
    //
    // An initiator who is neither party nor a payer admin resolves to no side
    // at all, which leaves nobody able to answer — the anti-oracle 404 below.
    // Fail closed: a proposal from an unidentifiable opener should not be
    // confirmable by whoever asks first.
    const initiatedByConsultant =
      !!open && !!consultantUserId && open.initiatedById === consultantUserId;
    const initiatedByConsultee =
      !!open && !!consulteeUserId && open.initiatedById === consulteeUserId;
    const initiatedByPayerAdmin =
      !!open &&
      !initiatedByConsultant &&
      !initiatedByConsultee &&
      !!open.appointment &&
      (await isOrgAdminOfAppointment(
        open.initiatedById,
        open.appointment,
        "reschedule",
      ));
    const counterpartyUserId = initiatedByConsultant
      ? consulteeUserId
      : initiatedByConsultee || initiatedByPayerAdmin
        ? consultantUserId
        : undefined;
    const isCounterparty =
      !!counterpartyUserId && session.user.id === counterpartyUserId;
    if (!open || !isCounterparty) {
      return NextResponse.json(
        { error: "No open reschedule request for this booking." },
        { status: 404 },
      );
    }
    // #1527 decision 6 — after the anti-oracle gate: a suspended learner
    // can't answer a proposal on an org-funded booking.
    if (
      session.user.id === consulteeUserId &&
      (await isSuspendedInFundingOrg(
        session.user.id,
        open.appointment?.organizationId,
      ))
    ) {
      return membershipSuspendedResponse();
    }

    if (parsed.data.action === "decline") {
      const result = await declineProposal({
        rescheduleRequestId: open.id,
        resolvedById: session.user.id,
      });
      if (!result.done) {
        return NextResponse.json(
          {
            error: "This proposal can no longer be answered.",
            code: result.reason,
          },
          { status: 409 },
        );
      }
      // A partial restore is reported as RELEASED, like the module's own
      // notification does: a session still owing a time is the stranded
      // problem, and it is the arm that tells the counterparty so.
      //
      // `result.restoredFully` is the restore's matched count as read inside the
      // transaction that did the restoring. This route used to recount the rows
      // itself, AFTER the lock was released — a second reader of a decision
      // already committed, free to disagree with it: a slot cancelled in the
      // gap turned a completed restore into "we could not put your times back"
      // and told a consultant their sessions were gone when they were not. The
      // module reports the outcome; this route words it.
      const outcome: RescheduleRespondCode = result.restoredFully
        ? "DECLINED"
        : "RELEASED";
      return NextResponse.json({
        declined: true,
        // #1846 — the released slots are restored by this decline, so the one
        // fixed sentence this route returned for every successful decline
        // ("they stay in the allocate queue") named the STRANDED outcome while
        // the slots had just been put back. The code is what a client branches
        // on; the message beside it is prose.
        outcome,
        message: DECLINE_OUTCOME_COPY[outcome],
      });
    }

    // #1008 — accept MOVES the booking's slots to new times, and a booking with
    // a live payment dispute is frozen: its state is evidence and must not move
    // while the dispute is contested. Both sibling routes (cancel, reschedule)
    // refuse the same movement.
    //
    // Deliberately placed AFTER the counterparty gate, not before it: answering
    // 409 to an unauthorized caller would turn this route into the dispute
    // oracle the 404 discipline above exists to prevent. Decline is exempt — it
    // moves the booking to no NEW time (it ends the request and, since #1846,
    // puts the released slots back where they were, which is where the hourly
    // expiry job leaves them regardless of any dispute).
    if (await hasActiveDisputeForAppointment(appointmentId)) {
      return NextResponse.json(
        {
          error:
            "This appointment has an open payment dispute and can't be rescheduled until it resolves.",
          code: "DISPUTE_ACTIVE",
        },
        { status: 409 },
      );
    }

    let eventType: EventType | null = null;
    if (open.appointment?.consultationId) eventType = "consultation";
    else if (open.appointment?.subscriptionId) eventType = "subscription";
    const eventId =
      open.appointment?.consultationId ?? open.appointment?.subscriptionId;
    if (!eventType || !eventId) {
      return NextResponse.json(
        { error: "This booking type cannot accept proposals." },
        { status: 422 },
      );
    }

    // #1340 — accept is a lifecycle mutation: it moves this appointment's slots
    // to new times. The sibling cancel and reschedule routes already serialize
    // on the `appointment-lock:` atom, so an accept that ran outside it was the
    // one mover that could interleave with a concurrent cancel — the allocator's
    // own consultant/consultee locks are keyed by person, not by appointment,
    // and never contend with a cancel at all. Lock order is unchanged: the
    // appointment atom is the coarsest and is taken before the allocator's.
    const result = await withAppointmentLock(appointmentId, () =>
      acceptProposal({
        rescheduleRequestId: open.id,
        eventType,
        eventId,
        resolvedById: session.user.id,
      }),
    );
    if (!result.done) {
      // Only "there is nothing here to accept" is a request-shape problem; every
      // other refusal is a state conflict.
      const status = result.reason === "NO_PROPOSED_TIMES" ? 422 : 409;
      return NextResponse.json(
        {
          error: ACCEPT_FAILURE_COPY[result.reason] ?? ACCEPT_FAILURE_FALLBACK,
          code: result.reason,
        },
        { status },
      );
    }
    return NextResponse.json({
      accepted: true,
      message:
        "Proposal accepted — the booking has moved to the proposed times.",
    });
  } catch (error) {
    // #1340 — lock outcomes are structured answers, never a 500, exactly as the
    // reschedule route already reports them: 423 while another lifecycle
    // mutation holds the appointment, 503 when the locking service itself is
    // unreachable and the guard fails closed.
    if (error instanceof AppointmentBusyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    return apiError({ tag: "[Reschedule.Respond]", error });
  }
}
