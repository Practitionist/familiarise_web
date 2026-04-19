/**
 * Staff Support Ticket Detail API
 * Get ticket details and update ticket (status, priority, assignment)
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, UserRole } from "@prisma/client";
import { notifySupportTicketUpdate } from "@/lib/novu";
import { UpdateSupportTicketSchema } from "@/schemas/support";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
interface RouteParams {
  params: Promise<{ ticketId: string }>;
}

/**
 * GET /api/staff/support-tickets/[ticketId]
 * Get full ticket details with responses, attachments, and linked entities
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { ticketId } = await params;

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            phone: true,
            createdAt: true,
          },
        },
        responses: {
          orderBy: { createdAt: "asc" },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                image: true,
                role: true,
              },
            },
          },
        },
        attachments: {
          orderBy: { uploadedAt: "desc" },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Fetch linked entities in parallel for better performance
    const [
      linkedConsultation,
      linkedSubscription,
      linkedPayment,
      linkedRefund,
    ] = await Promise.all([
      ticket.consultationId
        ? prisma.consultation.findUnique({
            where: { id: ticket.consultationId },
            include: {
              consultationPlan: {
                select: {
                  title: true,
                  price: true,
                  priceCurrency: true,
                  consultantProfile: {
                    include: {
                      user: { select: { name: true, email: true } },
                    },
                  },
                },
              },
              appointment: {
                select: {
                  id: true,
                  slotsOfAppointment: {
                    select: {
                      startsAt: true,
                    },
                    orderBy: {
                      startsAt: "asc",
                    },
                    take: 1,
                  },
                },
              },
            },
          })
        : Promise.resolve(null),
      ticket.subscriptionId
        ? prisma.subscription.findUnique({
            where: { id: ticket.subscriptionId },
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                  price: true,
                  priceCurrency: true,
                  consultantProfile: {
                    include: {
                      user: { select: { name: true, email: true } },
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve(null),
      ticket.paymentId
        ? prisma.payment.findUnique({
            where: { id: ticket.paymentId },
            select: {
              id: true,
              amount: true,
              currency: true,
              paymentStatus: true,
              paymentGateway: true,
              createdAt: true,
            },
          })
        : Promise.resolve(null),
      ticket.refundId
        ? prisma.refund.findUnique({
            where: { id: ticket.refundId },
            select: {
              id: true,
              amount: true,
              currency: true,
              status: true,
              reason: true,
              createdAt: true,
            },
          })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      ...ticket,
      linkedConsultation,
      linkedSubscription,
      linkedPayment,
      linkedRefund,
    });
  } catch (error) {
    console.error("Error fetching support ticket:", error);
    return NextResponse.json(
      { error: "Failed to fetch support ticket" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/staff/support-tickets/[ticketId]
 * Update ticket status, priority, or assignment
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { ticketId } = await params;
    const body = await req.json();
    const result = UpdateSupportTicketSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    // Validate ticket exists
    const existingTicket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!existingTicket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    // Build update data
    const updateData: Prisma.SupportTicketUpdateInput = {};

    if (validatedData.status) {
      updateData.status = validatedData.status;
    }

    if (validatedData.priority) {
      updateData.priority = validatedData.priority;
    }

    if (validatedData.assignedToId !== undefined) {
      // Validate assignee is staff/admin if not null
      if (validatedData.assignedToId !== null) {
        const assignee = await prisma.user.findUnique({
          where: { id: validatedData.assignedToId },
          select: { role: true },
        });

        if (
          !assignee ||
          (assignee.role !== UserRole.STAFF && assignee.role !== UserRole.ADMIN)
        ) {
          return NextResponse.json(
            { error: "Invalid assignee - must be staff or admin" },
            { status: 400 },
          );
        }
      }
      updateData.assignedToId = validatedData.assignedToId;
    }

    // Link to refund if provided
    if (validatedData.refundId) {
      updateData.refundId = validatedData.refundId;
    }

    const updatedTicket = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: updateData,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Notify the ticket owner about the update
    void notifySupportTicketUpdate(updatedTicket.user.id, {
      ticketId: updatedTicket.id,
      ticketTitle: updatedTicket.title || "Support Ticket",
      status: updatedTicket.status,
      dashboardUrl: "/dashboard",
    });

    return NextResponse.json(updatedTicket);
  } catch (error) {
    console.error("Error updating support ticket:", error);
    return NextResponse.json(
      { error: "Failed to update support ticket" },
      { status: 500 },
    );
  }
}
