/**
 * Staff Support Ticket Responses API
 * Staff can respond to any support ticket
 */

import { NextRequest, NextResponse } from "next/server";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
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

interface RouteParams {
  params: Promise<{ ticketId: string }>;
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
    const body = await req.json();
    const result = CreateSupportResponseSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
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
    const response = await prisma.$transaction(
      async (tx) => {
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

        if (ticket.status === "OPEN" && !validatedData.isInternal) {
          await tx.supportTicket.updateMany({
            where: { id: ticketId, status: "OPEN" },
            data: {
              status: "IN_PROGRESS",
              assignedToId: ticket.assignedToId || session.user.id,
            },
          });
        }

        if (!validatedData.isInternal) {
          await applyStaffReply(tx, ticketId, now);
          await tx.supportTicket.update({
            where: { id: ticketId },
            data: { lastMessageAt: now },
          });
          const linkedThread = await tx.appointmentSupportThread.findUnique({
            where: { supportTicketId: ticketId },
            select: { id: true },
          });
          if (linkedThread) {
            const seq = await allocateMessageSeq(tx, linkedThread.id, 1);
            await tx.supportMessage.create({
              data: {
                threadId: linkedThread.id,
                sender: "AGENT",
                body: validatedData.message,
                seq: seq + 1,
                authorUserId: session.user.id,
              },
            });
            await tx.appointmentSupportThread.update({
              where: { id: linkedThread.id },
              data: { lastMessageAt: now },
            });
          }
        }

        return created;
      },
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );

    // Notify the ticket owner about the staff response (skip for internal notes)
    if (!validatedData.isInternal) {
      await notifySupportTicketResponse(ticket.userId, {
        ticketId: ticket.id,
        reference: ticket.referenceNumber ?? undefined,
        ticketTitle: ticket.title || "Support Ticket",
        message: validatedData.message,
        // Declared on the payload and never passed, so a template naming the
        // responder rendered an empty attribution — same shape as the blank
        // reschedule times.
        respondedBy: response.user?.name ?? "Support",
        dashboardUrl: supportRequestHref(
          caseKeyOf({ kind: "ticket", id: ticket.id }),
          ticket.appointmentSupportThread?.organizationId,
        ),
        // ADR 23 — inherit the ticket's org-ness (attribution only).
        ...notificationScope(ticket.organizationId),
      });
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
