import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { notifySupportTicketCreated } from "@/lib/novu";
import { CreateSupportTicketSchema } from "@/schemas/support";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";

import { getSession } from "@/lib/auth-server";
import { assertBodySize } from "@/lib/validation/limits";
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to access your support tickets" },
        { status: 401 },
      );
    }

    const tickets = await prisma.supportTicket.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        responses: {
          where: {
            isInternal: false, // Don't show internal notes to users
          },
          orderBy: {
            createdAt: "asc",
          },
          include: {
            user: {
              select: {
                name: true,
                role: true,
              },
            },
          },
        },
        attachments: {
          orderBy: {
            uploadedAt: "desc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(tickets);
  } catch (error) {
    console.error("Error fetching support tickets:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while fetching your support tickets",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to create a support ticket" },
        { status: 401 },
      );
    }

    // Rate limit: 5 support tickets per hour per user
    const rl = await applyRateLimit(spamLimiter, `tickets:${session.user.id}`);
    if (rl) return rl;

    // #831 — cap request body before parsing
    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = await req.json();
    const result = CreateSupportTicketSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    // Resolve appointmentId to consultationId/subscriptionId if provided
    let resolvedConsultationId = validatedData.consultationId;
    let resolvedSubscriptionId = validatedData.subscriptionId;

    if (validatedData.appointmentId) {
      const appointment = await prisma.appointment.findFirst({
        where: {
          id: validatedData.appointmentId,
          OR: [
            { consultation: { requestedBy: { userId: session.user.id } } },
            { subscription: { requestedBy: { userId: session.user.id } } },
          ],
        },
        include: {
          consultation: true,
          subscription: true,
        },
      });

      if (!appointment) {
        return NextResponse.json(
          { error: "Invalid appointment ID or unauthorized" },
          { status: 400 },
        );
      }

      // Resolve to actual consultation/subscription IDs
      if (appointment.consultation) {
        resolvedConsultationId = appointment.consultation.id;
      } else if (appointment.subscription) {
        resolvedSubscriptionId = appointment.subscription.id;
      }
    }

    // Validate entity links in parallel - ensure they belong to this user
    // Skip validation for IDs resolved from appointmentId (already validated above)
    const validations = await Promise.all([
      resolvedConsultationId && !validatedData.appointmentId
        ? prisma.consultation
            .findFirst({
              where: {
                id: resolvedConsultationId,
                requestedBy: { userId: session.user.id },
              },
            })
            .then((c) => ({ type: "consultation", valid: !!c }))
        : Promise.resolve({ type: "consultation", valid: true }),
      resolvedSubscriptionId && !validatedData.appointmentId
        ? prisma.subscription
            .findFirst({
              where: {
                id: resolvedSubscriptionId,
                requestedBy: { userId: session.user.id },
              },
            })
            .then((s) => ({ type: "subscription", valid: !!s }))
        : Promise.resolve({ type: "subscription", valid: true }),
      validatedData.paymentId
        ? prisma.payment
            .findFirst({
              where: {
                id: validatedData.paymentId,
                userId: session.user.id,
              },
            })
            .then((p) => ({ type: "payment", valid: !!p }))
        : Promise.resolve({ type: "payment", valid: true }),
    ]);

    const invalidEntity = validations.find((v) => !v.valid);
    if (invalidEntity) {
      return NextResponse.json(
        { error: `Invalid ${invalidEntity.type} ID` },
        { status: 400 },
      );
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        title: validatedData.title,
        description: validatedData.description,
        priority: validatedData.priority || "MEDIUM",
        category: validatedData.category,
        issueType: validatedData.issueType,
        consultationId: resolvedConsultationId,
        subscriptionId: resolvedSubscriptionId,
        paymentId: validatedData.paymentId,
        user: { connect: { id: session.user.id } },
      },
      include: {
        responses: true,
        attachments: true,
      },
    });

    // Notify staff/admin users about the new support ticket
    const staffUsers = await prisma.user.findMany({
      where: { role: { in: ["STAFF", "ADMIN"] } },
      select: { id: true },
    });
    void notifySupportTicketCreated(
      staffUsers.map((u) => u.id),
      {
        ticketId: ticket.id,
        ticketTitle: ticket.title || "Support Ticket",
        dashboardUrl: "/dashboard/admin/tickets",
      },
    );

    return NextResponse.json(ticket, { status: 201 });
  } catch (error) {
    console.error("Error creating support ticket:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while creating your support ticket",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
