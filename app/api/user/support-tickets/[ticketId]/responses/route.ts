import { NextRequest, NextResponse } from "next/server";
import { supportError } from "@/lib/api/support-http";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { stripCallbackTags } from "@/lib/validation/phone";
import { CreateSupportResponseSchema } from "@/schemas/support";
import * as Sentry from "@sentry/nextjs";
import { userRepliedPatch } from "@/lib/support/sla";
import { allocateMessageSeq } from "@/lib/support/message-seq";
import { notifyStaffOfTicketActivity } from "@/lib/support/create-ticket";

function resolveUserReplyNextStatus(
  status: string,
  assignedToId: string | null,
): "IN_PROGRESS" | "OPEN" {
  if (status === "RESOLVED" || status === "ON_HOLD") {
    return assignedToId ? "IN_PROGRESS" : "OPEN";
  }
  return "IN_PROGRESS";
}

async function mirrorUserReplyToThread(
  tx: Tx,
  thread: { id: string; status: string } | null,
  cleanMessage: string,
  userId: string,
  now: Date,
): Promise<void> {
  if (!thread || thread.status === "CLOSED") return;
  const movedThread = await tx.appointmentSupportThread.updateMany({
    where: { id: thread.id, status: { not: "CLOSED" } },
    data: {
      lastMessageAt: now,
      status: "ESCALATED",
      resolvedAt: null,
    },
  });
  if (movedThread.count > 0) {
    const seq = await allocateMessageSeq(tx, thread.id, 1);
    await tx.supportMessage.create({
      data: {
        threadId: thread.id,
        seq: seq + 1,
        sender: "USER",
        body: cleanMessage,
        authorUserId: userId,
      },
    });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const [session, resolvedParams] = await Promise.all([getSession(), params]);

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
    const rawBody: unknown = await req.json().catch(() => null);
    const parsed = CreateSupportResponseSchema.safeParse(rawBody);
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: "user.support-tickets.responses", action: "reply" },
      });
    }
    const cleanMessage = stripCallbackTags(parsed.data.message).trim();
    if (!cleanMessage) {
      return NextResponse.json(
        { error: "Validation failed", message: "Message is required" },
        { status: 400 },
      );
    }

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
    const nextStatus = resolveUserReplyNextStatus(
      ticket.status,
      ticket.assignedToId,
    );

    const response = await prisma.$transaction(
      async (tx) => {
        const updated = await tx.supportTicket.updateMany({
          where: {
            id: ticketId,
            status: ticket.status,
            awaitingUserSince: ticket.awaitingUserSince,
            pausedSeconds: ticket.pausedSeconds,
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
            message: cleanMessage,
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

        await mirrorUserReplyToThread(
          tx,
          ticket.appointmentSupportThread,
          cleanMessage,
          session.user.id,
          now,
        );

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

    await notifyStaffOfTicketActivity(
      ticketId,
      ticket.organizationId,
      response.id,
    ).catch((error) => {
      console.error("support: user-reply notification failed", {
        ticketId,
        error,
      });
    });

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
      },
      { status: 500 },
    );
  }
}
