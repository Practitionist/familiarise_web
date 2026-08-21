/**
 * Staff Support Ticket Responses API
 * Staff can respond to any support ticket
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { notifySupportTicketResponse } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { CreateSupportResponseSchema } from "@/schemas/support";
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

    // Verify the ticket exists
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Create the response
    const response = await prisma.supportResponse.create({
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

    // Update ticket status to IN_PROGRESS if it was OPEN
    // Only update if this is not an internal note
    if (ticket.status === "OPEN" && !validatedData.isInternal) {
      // Status-guarded CAS: a concurrent staff edit that already moved the
      // ticket off OPEN must not be clobbered back. updateMany is a no-op
      // (count 0) when the guard misses, so the loser silently yields.
      await prisma.supportTicket.updateMany({
        where: { id: ticketId, status: "OPEN" },
        data: {
          status: "IN_PROGRESS",
          // Auto-assign to responding staff if not already assigned
          assignedToId: ticket.assignedToId || session.user.id,
        },
      });
    }

    // #support-hub — mirror public replies into the linked per-appointment
    // thread as AGENT messages. The thread is what the USER sees ("Get help"
    // on their session); without this, replies sent from the ticket queue
    // were invisible on the conversation surface. Internal notes stay
    // ticket-only. The Conversations-inbox reply path mirrors the other way
    // (thread → ticket); together the two histories never diverge.
    if (!validatedData.isInternal) {
      const linkedThread = await prisma.appointmentSupportThread.findUnique({
        where: { supportTicketId: ticketId },
        select: { id: true },
      });
      if (linkedThread) {
        const now = new Date();
        await prisma.supportMessage.create({
          data: {
            threadId: linkedThread.id,
            sender: "AGENT",
            body: validatedData.message,
          },
        });
        await prisma.appointmentSupportThread.update({
          where: { id: linkedThread.id },
          data: { lastMessageAt: now },
        });
      }
    }

    // Notify the ticket owner about the staff response (skip for internal notes)
    if (!validatedData.isInternal) {
      void notifySupportTicketResponse(ticket.userId, {
        ticketId: ticket.id,
        ticketTitle: ticket.title || "Support Ticket",
        message: validatedData.message,
        // Declared on the payload and never passed, so a template naming the
        // responder rendered an empty attribution — same shape as the blank
        // reschedule times.
        respondedBy: response.user?.name ?? "Support",
        dashboardUrl: "/dashboard",
        // ADR 23 — inherit the ticket's org-ness (attribution only).
        ...notificationScope(ticket.organizationId),
      });
    }

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error fetching support responses:", error);
    return NextResponse.json(
      { error: "Failed to fetch responses" },
      { status: 500 },
    );
  }
}
