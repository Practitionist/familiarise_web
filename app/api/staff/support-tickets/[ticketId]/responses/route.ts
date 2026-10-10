/**
 * Staff Support Ticket Responses API
 * Staff can respond to any support ticket
 */

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

    if (
      !validatedData.isInternal &&
      validatedData.expectedLastMessageAt &&
      ticket.lastMessageAt &&
      ticket.lastMessageAt.getTime() >
        new Date(validatedData.expectedLastMessageAt).getTime()
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

    const now = new Date();
    const response = await prisma.$transaction(
      async (tx) => {
        if (!validatedData.isInternal) {
          const picked =
            ticket.status === "OPEN"
              ? await tx.supportTicket.updateMany({
                  where: { id: ticketId, status: "OPEN" },
                  data: {
                    status: "IN_PROGRESS",
                    assignedToId: ticket.assignedToId ?? session.user.id,
                    lastMessageAt: now,
                  },
                })
              : { count: 0 };
          if (picked.count === 0) {
            const touched = await tx.supportTicket.updateMany({
              where: { id: ticketId, status: { not: "CLOSED" } },
              data: { lastMessageAt: now },
            });
            if (touched.count === 0) {
              return null;
            }
          }
        }

        const created = await tx.supportResponse.create({
          data: {
            message: validatedData.message,
            isInternal: validatedData.isInternal,
            supportTicket: { connect: { id: ticketId } },
            user: { connect: { id: session.user.id } },
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

        if (!validatedData.isInternal) {
          await applyStaffReply(tx, ticketId, now);
          await mirrorStaffReplyToThread(
            tx,
            ticketId,
            validatedData.message,
            session.user.id,
            now,
          );
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
        { error: "Cannot send a public reply to a closed ticket" },
        { status: 409 },
      );
    }

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
