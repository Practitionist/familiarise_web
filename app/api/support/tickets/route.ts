import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import {
  createSupportTicket,
  findOpenTicketForPayment,
  isSessionScopedIssueType,
} from "@/lib/support/create-ticket";
import { CreateSupportTicketSchema } from "@/schemas/support";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { getSession } from "@/lib/auth-server";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
import { canRaiseAboutOrg } from "@/lib/support/about-org";

const TICKETS_ROUTE = "support.tickets";

const SupportTicketsPostSchema = CreateSupportTicketSchema.extend({
  targetUserId: z.string().trim().min(1).max(200).optional(),
});

export async function GET() {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }

    const tickets = await prisma.supportTicket.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        responses: {
          where: {
            isInternal: false,
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
        organization: { select: { id: true, name: true } },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(tickets);
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: TICKETS_ROUTE, action: "list" },
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }

    const rl = await applyRateLimit(spamLimiter, `tickets:${session.user.id}`);
    if (rl) return rl;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = await req.json();
    const result = SupportTicketsPostSchema.safeParse(body);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: TICKETS_ROUTE, action: "create" },
      });
    }
    const validatedData = result.data;

    const isOperator =
      session.user.role === "ADMIN" || session.user.role === "STAFF";

    if (validatedData.targetUserId && !isOperator) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        message: "Only staff or admin operators can open outbound tickets.",
        context: { route: TICKETS_ROUTE, action: "create" },
      });
    }

    let ticketUserId = session.user.id;
    if (validatedData.targetUserId) {
      const targetLookup = validatedData.targetUserId;
      const targetUser = targetLookup.includes("@")
        ? await prisma.user.findFirst({
            where: { email: { equals: targetLookup, mode: "insensitive" } },
            select: { id: true },
          })
        : await prisma.user.findUnique({
            where: { id: targetLookup },
            select: { id: true },
          });

      if (!targetUser) {
        return supportError({
          status: 404,
          code: "NOT_FOUND",
          message: "Target user not found.",
          context: { route: TICKETS_ROUTE, action: "create" },
        });
      }
      ticketUserId = targetUser.id;
    }

    if (
      !validatedData.targetUserId &&
      isSessionScopedIssueType(validatedData.issueType)
    ) {
      return NextResponse.json(
        {
          error:
            "This issue is about a specific session — open the appointment and use 'Get help' so our team gets the session context.",
          code: "SESSION_SCOPED_ISSUE",
        },
        { status: 422 },
      );
    }

    let resolvedConsultationId = validatedData.appointmentId
      ? undefined
      : validatedData.consultationId;
    let resolvedSubscriptionId = validatedData.appointmentId
      ? undefined
      : validatedData.subscriptionId;

    if (validatedData.appointmentId) {
      const appointment = await prisma.appointment.findFirst({
        where: {
          id: validatedData.appointmentId,
          ...(isOperator
            ? {}
            : {
                OR: [
                  { consultation: { requestedBy: { userId: ticketUserId } } },
                  { subscription: { requestedBy: { userId: ticketUserId } } },
                ],
              }),
        },
        include: {
          consultation: true,
          subscription: true,
        },
      });

      if (!appointment) {
        return supportError({
          status: 400,
          code: "INVALID_ID",
          message: "Invalid appointment ID or unauthorized",
          context: {
            route: TICKETS_ROUTE,
            action: "create",
            appointmentId: validatedData.appointmentId,
          },
        });
      }

      if (appointment.consultation) {
        resolvedConsultationId = appointment.consultation.id;
      } else if (appointment.subscription) {
        resolvedSubscriptionId = appointment.subscription.id;
      }
    }

    if (!isOperator) {
      const validations = await Promise.all([
        resolvedConsultationId && !validatedData.appointmentId
          ? prisma.consultation
              .findFirst({
                where: {
                  id: resolvedConsultationId,
                  requestedBy: { userId: ticketUserId },
                },
              })
              .then((c) => ({ type: "consultation", valid: !!c }))
          : Promise.resolve({ type: "consultation", valid: true }),
        resolvedSubscriptionId && !validatedData.appointmentId
          ? prisma.subscription
              .findFirst({
                where: {
                  id: resolvedSubscriptionId,
                  requestedBy: { userId: ticketUserId },
                },
              })
              .then((s) => ({ type: "subscription", valid: !!s }))
          : Promise.resolve({ type: "subscription", valid: true }),
        validatedData.paymentId
          ? prisma.payment
              .findFirst({
                where: {
                  id: validatedData.paymentId,
                  userId: ticketUserId,
                },
              })
              .then((p) => ({ type: "payment", valid: !!p }))
          : Promise.resolve({ type: "payment", valid: true }),
      ]);

      const invalidEntity = validations.find((v) => !v.valid);
      if (invalidEntity) {
        return supportError({
          status: 400,
          code: "INVALID_ID",
          message: `Invalid ${invalidEntity.type} ID`,
          context: {
            route: TICKETS_ROUTE,
            action: "create",
            entity: invalidEntity.type,
          },
        });
      }
    }

    if (validatedData.paymentId && !validatedData.targetUserId) {
      const existing = await findOpenTicketForPayment(
        ticketUserId,
        validatedData.paymentId,
      );
      if (existing) {
        return NextResponse.json(existing, { status: 200 });
      }
    }

    let organizationId: string | null = null;
    if (validatedData.organizationId) {
      if (isOperator) {
        organizationId = validatedData.organizationId;
      } else {
        const membership = await prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: session.user.id,
              organizationId: validatedData.organizationId,
            },
          },
          select: { role: true, status: true },
        });
        if (!membership || !canRaiseAboutOrg(membership)) {
          return supportError({
            status: 403,
            code: "FORBIDDEN",
            context: {
              route: TICKETS_ROUTE,
              action: "create",
              attemptedOrgId: validatedData.organizationId,
            },
          });
        }
        organizationId = validatedData.organizationId;
      }
    }

    const ticket = await createSupportTicket({
      userId: ticketUserId,
      title: validatedData.title,
      description: validatedData.description,
      priority: validatedData.priority || "MEDIUM",
      category: validatedData.category,
      issueType: validatedData.issueType ?? "GENERAL_INQUIRY",
      organizationId,
      consultationId: resolvedConsultationId,
      subscriptionId: resolvedSubscriptionId,
      paymentId: validatedData.paymentId,
    });

    return NextResponse.json(ticket, { status: 201 });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: TICKETS_ROUTE, action: "create" },
    });
  }
}
