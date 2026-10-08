import { NextRequest, NextResponse } from "next/server";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "lib/prisma";
import { getSession } from "@/lib/auth-server";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { CreateSupportResponseSchema } from "@/schemas/support";
import * as Sentry from "@sentry/nextjs";
import { userRepliedPatch } from "@/lib/support/sla";
import { allocateMessageSeq } from "@/lib/support/message-seq";
import { notifyStaffOfTicketActivity } from "@/lib/support/create-ticket";
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const [session, resolvedParams] = await Promise.all([
      getSession(true),
      params,
    ]);

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to respond to support tickets" },
        { status: 401 },
      );
    }

    const rl = await applyRateLimit(
      spamLimiter,
      `ticket-response:${session.user.id}`,
    );
    if (rl) return rl;
    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const { ticketId } = resolvedParams;
    const parsed = CreateSupportResponseSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const body = parsed.data;

    const ticket = await prisma.supportTicket.findFirst({
      where: {
        id: ticketId,
        userId: session.user.id,
      },
      include: {
        appointmentSupportThread: {
          select: { id: true, status: true },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json(
        {
          error:
            "This support ticket does not exist or you don't have permission to access it",
        },
        { status: 404 },
      );
    }

    if (ticket.status === "CLOSED") {
      return NextResponse.json(
        {
          error:
            "This support ticket is closed and can no longer receive replies.",
        },
        { status: 400 },
      );
    }

    const now = new Date();
    const nextStatus =
      ticket.status === "RESOLVED" || ticket.status === "ON_HOLD"
        ? ticket.assignedToId
          ? "IN_PROGRESS"
          : "OPEN"
        : "IN_PROGRESS";

    const response = await prisma.$transaction(
      async (tx) => {
        const updated = await tx.supportTicket.updateMany({
          where: {
            id: ticketId,
            status: ticket.status,
            awaitingUserSince: ticket.awaitingUserSince,
          },
          data: {
            lastMessageAt: now,
            status: nextStatus,
            resolvedAt: null,
            closedAt: null,
            ...userRepliedPatch(ticket, now),
          },
        });
        if (updated.count === 0) {
          return null;
        }

        const created = await tx.supportResponse.create({
          data: {
            message: body.message,
            supportTicket: { connect: { id: ticketId } },
            user: { connect: { id: session.user.id } },
          },
          include: {
            user: {
              select: {
                name: true,
                role: true,
              },
            },
          },
        });

        if (
          ticket.appointmentSupportThread &&
          ticket.appointmentSupportThread.status !== "CLOSED"
        ) {
          const threadId = ticket.appointmentSupportThread.id;
          const seq = await allocateMessageSeq(tx, threadId, 1);
          await tx.supportMessage.create({
            data: {
              threadId,
              seq: seq + 1,
              sender: "USER",
              body: body.message,
              authorUserId: session.user.id,
            },
          });
          await tx.appointmentSupportThread.update({
            where: { id: threadId },
            data: {
              lastMessageAt: now,
              status: "ESCALATED",
              resolvedAt: null,
            },
          });
        }

        return created;
      },
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );

    if (!response) {
      return NextResponse.json(
        { error: "Ticket was updated concurrently; please refresh and retry." },
        { status: 409 },
      );
    }

    await notifyStaffOfTicketActivity(ticketId, null, response.id).catch(
      (error) => {
        console.error("support: user-reply notification failed", {
          ticketId,
          error,
        });
      },
    );

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "support" } },
    );
    console.error("Error creating support response:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while submitting your response",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
