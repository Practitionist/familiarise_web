import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/errors";
import {
  acceptProposal,
  declineProposal,
} from "@/lib/booking/reschedule-respond";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import type { EventType } from "@/utils/slotAllocation/types";

const RespondSchema = z.object({ action: z.enum(["accept", "decline"]) });

/**
 * POST /api/appointments/[appointmentId]/reschedule/respond
 *
 * The counterparty answers the open proposal (#1163). Accept re-validates the
 * proposed times through the full allocator; decline ends the request and
 * deliberately leaves the released slots in the consultant's allocate queue.
 * The initiator has withdraw, which is the restoring exit.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const parsed = RespondSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "action must be \"accept\" or \"decline\"" },
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
        appointment: {
          select: {
            consultationId: true,
            subscriptionId: true,
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
    const booking =
      open?.appointment?.consultation ?? open?.appointment?.subscription;
    const participants = [
      booking?.requestedBy?.userId,
      (booking as { consultationPlan?: { consultantProfile: { userId: string } } })
        ?.consultationPlan?.consultantProfile?.userId ??
        (booking as { subscriptionPlan?: { consultantProfile: { userId: string } } })
          ?.subscriptionPlan?.consultantProfile?.userId,
    ].filter(Boolean);
    const isCounterparty =
      !!open &&
      participants.includes(session.user.id) &&
      open.initiatedById !== session.user.id;
    if (!open || !isCounterparty) {
      return NextResponse.json(
        { error: "No open reschedule request for this booking." },
        { status: 404 },
      );
    }

    if (parsed.data.action === "decline") {
      const result = await declineProposal({
        rescheduleRequestId: open.id,
        resolvedById: session.user.id,
      });
      if (!result.done) {
        return NextResponse.json(
          { error: "This proposal can no longer be answered.", code: result.reason },
          { status: 409 },
        );
      }
      return NextResponse.json({
        declined: true,
        message:
          "Proposal declined. The released times stay in the allocate queue until new times are placed.",
      });
    }

    const eventType: EventType | null = open.appointment?.consultationId
      ? "consultation"
      : open.appointment?.subscriptionId
        ? "subscription"
        : null;
    const eventId =
      open.appointment?.consultationId ?? open.appointment?.subscriptionId;
    if (!eventType || !eventId) {
      return NextResponse.json(
        { error: "This booking type cannot accept proposals." },
        { status: 422 },
      );
    }

    const result = await acceptProposal({
      rescheduleRequestId: open.id,
      eventType,
      eventId,
      resolvedById: session.user.id,
    });
    if (!result.done) {
      const status =
        result.reason === "PROPOSAL_NOT_OPEN"
          ? 409
          : result.reason === "NO_PROPOSED_TIMES"
            ? 422
            : 409;
      return NextResponse.json(
        {
          error:
            result.reason === "NO_PROPOSED_TIMES"
              ? "This request proposes no concrete times — place times on the calendar instead."
              : "The proposed times could not be confirmed.",
          code: result.reason,
        },
        { status },
      );
    }
    return NextResponse.json({
      accepted: true,
      message: "Proposal accepted — the booking has moved to the proposed times.",
    });
  } catch (error) {
    return apiError({ tag: "[Reschedule.Respond]", error });
  }
}
