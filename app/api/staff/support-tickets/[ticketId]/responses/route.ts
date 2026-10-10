/**
 * Staff Support Ticket Responses API
 * Staff can respond to any support ticket
 */

import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supportError } from "@/lib/api/support-http";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { notifySupportTicketResponse } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "@/lib/support/case-key";
import { CreateSupportResponseSchema } from "@/schemas/support";
import { allocateMessageSeq } from "@/lib/support/message-seq";
import { applyStaffReply } from "@/lib/support/sla";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";

const StaffCreateResponseSchema = CreateSupportResponseSchema.extend({
  expectedLastMessageAt: z.string().datetime().optional(),
});

interface RouteParams {
  params: Promise<{ ticketId: string }>;
}

type PublicReplyGuardFailure = {
  ok: false;
  code: "NEW_CUSTOMER_MESSAGE" | "CLOSED";
};

async function guardTicketPublicReplyTx(params: {
  tx: Tx;
  ticketId: string;
  ticketStatus: Prisma.SupportTicketGetPayload<object>["status"];
  ticketAssignedToId: string | null;
  fallbackLastMessageAt: Date | null;
  sessionUserId: string;
  expectedDate: Date | undefined;
  now: Date;
}): Promise<PublicReplyGuardFailure | null> {
  const {
    tx,
    ticketId,
    ticketStatus,
    ticketAssignedToId,
    fallbackLastMessageAt,
    sessionUserId,
    expectedDate,
    now,
  } = params;
  const collisionClause = expectedDate
    ? {
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: expectedDate } }],
      }
    : {};
  const moved = await tx.supportTicket.updateMany({
    where: {
      id: ticketId,
      status: { not: "CLOSED" },
      ...collisionClause,
    },
    data: {
      status: ticketStatus === "OPEN" ? "IN_PROGRESS" : ticketStatus,
      ...(ticketAssignedToId === null ? { assignedToId: sessionUserId } : {}),
      lastMessageAt: now,
    },
  });
  if ((moved?.count ?? 0) > 0) return null;

  const current = await tx.supportTicket.findUnique({
    where: { id: ticketId },
    select: { status: true, lastMessageAt: true },
  });
  const latestMessageAt = current?.lastMessageAt ?? fallbackLastMessageAt;
  if (
    expectedDate &&
    latestMessageAt &&
    latestMessageAt.getTime() > expectedDate.getTime()
  ) {
    return { ok: false, code: "NEW_CUSTOMER_MESSAGE" };
  }
  return { ok: false, code: "CLOSED" };
}

async function mirrorStaffReplyToThread(
  tx: Tx,
  ticketId: string,
  message: string,
  staffUserId: string,
  now: Date,
): Promise<void> {
  const linkedThread = await tx.appointmentSupportThread.findUnique({
    where: { supportTicketId: ticketId },
    select: { id: true },
  });
  if (!linkedThread) return;
  const movedThread = await tx.appointmentSupportThread.updateMany({
    where: { id: linkedThread.id, status: { not: "CLOSED" } },
    data: { lastMessageAt: now },
  });
  if (movedThread.count > 0) {
    const seq = await allocateMessageSeq(tx, linkedThread.id, 1);
    await tx.supportMessage.create({
      data: {
        threadId: linkedThread.id,
        sender: "AGENT",
        body: message,
        seq: seq + 1,
        authorUserId: staffUserId,
      },
    });
  }
}

async function executeTicketResponseTx(params: {
  ticketId: string;
  ticketStatus: Prisma.SupportTicketGetPayload<object>["status"];
  ticketAssignedToId: string | null;
  fallbackLastMessageAt: Date | null;
  sessionUserId: string;
  message: string;
  isInternal: boolean;
  expectedDate: Date | undefined;
  now: Date;
}) {
  const {
    ticketId,
    ticketStatus,
    ticketAssignedToId,
    fallbackLastMessageAt,
    sessionUserId,
    message,
    isInternal,
    expectedDate,
    now,
  } = params;
  return prisma.$transaction(
    async (tx) => {
      if (!isInternal) {
        const failure = await guardTicketPublicReplyTx({
          tx,
          ticketId,
          ticketStatus,
          ticketAssignedToId,
          fallbackLastMessageAt,
          sessionUserId,
          expectedDate,
          now,
        });
        if (failure) return failure;
      }

      const created = await tx.supportResponse.create({
        data: {
          message,
          isInternal,
          supportTicket: { connect: { id: ticketId } },
          user: { connect: { id: sessionUserId } },
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              role: true,
              image: true,
            },
          },
        },
      });

      if (!isInternal) {
        await applyStaffReply(tx, ticketId, now);
        await mirrorStaffReplyToThread(
          tx,
          ticketId,
          message,
          sessionUserId,
          now,
        );
      }

      return { ok: true as const, created };
    },
    {
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );
}

/**
 * POST /api/staff/support-tickets/[ticketId]/responses
 * Staff/Admin can respond to any support ticket
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { ticketId } = await params;
    const body: unknown = await req.json().catch(() => null);
    const result = StaffCreateResponseSchema.safeParse(body);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: "staff.support-tickets.responses", action: "reply" },
      });
    }
    const validatedData = result.data;

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        appointmentSupportThread: { select: { organizationId: true } },
      },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    if (ticket.status === "CLOSED" && !validatedData.isInternal) {
      return NextResponse.json(
        { error: "Cannot send a public reply to a closed ticket" },
        { status: 400 },
      );
    }

    const now = new Date();
    const expectedDate =
      !validatedData.isInternal && validatedData.expectedLastMessageAt
        ? new Date(validatedData.expectedLastMessageAt)
        : undefined;

    if (
      expectedDate &&
      ticket.lastMessageAt &&
      ticket.lastMessageAt.getTime() > expectedDate.getTime()
    ) {
      return NextResponse.json(
        {
          code: "NEW_CUSTOMER_MESSAGE",
          error:
            "Customer replied since you opened this case. Review their message before sending.",
        },
        { status: 409 },
      );
    }

    const txOutcome = await executeTicketResponseTx({
      ticketId,
      ticketStatus: ticket.status,
      ticketAssignedToId: ticket.assignedToId,
      fallbackLastMessageAt: ticket.lastMessageAt,
      sessionUserId: session.user.id,
      message: validatedData.message,
      isInternal: validatedData.isInternal,
      expectedDate,
      now,
    });

    if (!txOutcome.ok) {
      if (txOutcome.code === "NEW_CUSTOMER_MESSAGE") {
        return NextResponse.json(
          {
            code: "NEW_CUSTOMER_MESSAGE",
            error:
              "Customer replied since you opened this case. Review their message before sending.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "Cannot send a public reply to a closed ticket" },
        { status: 409 },
      );
    }

    const response = txOutcome.created;

    // Notify the ticket owner about the staff response (skip for internal notes)
    if (!validatedData.isInternal) {
      await notifySupportTicketResponse(
        ticket.userId,
        {
          ticketId: ticket.id,
          reference: ticket.referenceNumber ?? undefined,
          ticketTitle: ticket.title || "Support Ticket",
          message: validatedData.message,
          respondedBy: response.user?.name ?? "Support",
          dashboardUrl: supportRequestHref(
            caseKeyOf({ kind: "ticket", id: ticket.id }),
            ticket.appointmentSupportThread?.organizationId,
          ),
          ...notificationScope(ticket.organizationId),
        },
        `ticket-resp:${response.id}`,
      );
    }

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error creating support response:", error);
    return NextResponse.json(
      { error: "Failed to create response" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/staff/support-tickets/[ticketId]/responses
 * Get all responses for a ticket (including internal notes for staff)
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { ticketId } = await params;

    const responses = await prisma.supportResponse.findMany({
      where: { supportTicketId: ticketId },
      orderBy: { createdAt: "asc" },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            role: true,
            image: true,
          },
        },
      },
    });

    return NextResponse.json(responses);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching support responses:", error);
    return NextResponse.json(
      { error: "Failed to fetch responses" },
      { status: 500 },
    );
  }
}
