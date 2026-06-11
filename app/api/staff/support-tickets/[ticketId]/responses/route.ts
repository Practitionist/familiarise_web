/**
 * Staff Support Ticket Responses API
 * Staff can respond to any support ticket
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { notifySupportTicketResponse } from "@/lib/novu";
import { CreateSupportResponseSchema } from "@/schemas/support";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

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
      await prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: "IN_PROGRESS",
          // Auto-assign to responding staff if not already assigned
          assignedToId: ticket.assignedToId || session.user.id,
        },
      });
    }

    // Notify the ticket owner about the staff response (skip for internal notes)
    if (!validatedData.isInternal) {
      void notifySupportTicketResponse(ticket.userId, {
        ticketId: ticket.id,
        ticketTitle: ticket.title || "Support Ticket",
        message: validatedData.message,
        dashboardUrl: "/dashboard",
      });
    }

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
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
    console.error("Error fetching support responses:", error);
    return NextResponse.json(
      { error: "Failed to fetch responses" },
      { status: 500 },
    );
  }
}
