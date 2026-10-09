import { NextRequest, NextResponse } from "next/server";
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
import { stripCallbackTags } from "@/lib/validation/phone";
import { supportError } from "@/lib/api/support-http";
import { canRaiseAboutOrg } from "@/lib/support/about-org";
import type { z } from "zod";
import { withSupportAttachmentHrefs } from "@/lib/support/attachment-href";

const TICKETS_ROUTE = "user.support-tickets";

type CreateTicketPayload = z.infer<typeof CreateSupportTicketSchema>;

async function resolveTicketEntityLinks(
  userId: string,
  validatedData: CreateTicketPayload,
): Promise<
  | {
      ok: true;
      consultationId: string | undefined;
      subscriptionId: string | undefined;
    }
  | { ok: false; response: NextResponse }
> {
  // When appointmentId is given, client consultationId/subscriptionId are ignored so appointment ownership is authoritative.
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
        OR: [
          { consultation: { requestedBy: { userId } } },
          { subscription: { requestedBy: { userId } } },
        ],
      },
      include: {
        consultation: true,
        subscription: true,
      },
    });

    if (!appointment) {
      return {
        ok: false,
        response: supportError({
          status: 400,
          code: "INVALID_ID",
          message: "Invalid appointment ID or unauthorized",
          context: {
            route: TICKETS_ROUTE,
            action: "create",
            appointmentId: validatedData.appointmentId,
          },
        }),
      };
    }

    if (appointment.consultation) {
      resolvedConsultationId = appointment.consultation.id;
    } else if (appointment.subscription) {
      resolvedSubscriptionId = appointment.subscription.id;
    }
  }

  const validations = await Promise.all([
    resolvedConsultationId && !validatedData.appointmentId
      ? prisma.consultation
          .findFirst({
            where: {
              id: resolvedConsultationId,
              requestedBy: { userId },
            },
          })
          .then((c) => ({ type: "consultation", valid: !!c }))
      : Promise.resolve({ type: "consultation", valid: true }),
    resolvedSubscriptionId && !validatedData.appointmentId
      ? prisma.subscription
          .findFirst({
            where: {
              id: resolvedSubscriptionId,
              requestedBy: { userId },
            },
          })
          .then((s) => ({ type: "subscription", valid: !!s }))
      : Promise.resolve({ type: "subscription", valid: true }),
    validatedData.paymentId
      ? prisma.payment
          .findFirst({
            where: {
              id: validatedData.paymentId,
              userId,
            },
          })
          .then((p) => ({ type: "payment", valid: !!p }))
      : Promise.resolve({ type: "payment", valid: true }),
  ]);

  const invalidEntity = validations.find((v) => !v.valid);
  if (invalidEntity) {
    return {
      ok: false,
      response: supportError({
        status: 400,
        code: "INVALID_ID",
        message: `Invalid ${invalidEntity.type} ID`,
        context: {
          route: TICKETS_ROUTE,
          action: "create",
          entity: invalidEntity.type,
        },
      }),
    };
  }

  return {
    ok: true,
    consultationId: resolvedConsultationId,
    subscriptionId: resolvedSubscriptionId,
  };
}

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
        organization: { select: { id: true, name: true } },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(
      tickets.map((ticket) => ({
        ...ticket,
        attachments: withSupportAttachmentHrefs(ticket.attachments),
      })),
    );
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

    // Rate limit: 5 support tickets per hour per user
    const rl = await applyRateLimit(spamLimiter, `tickets:${session.user.id}`);
    if (rl) return rl;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const rawBody: unknown = await req.json().catch(() => null);
    const result = CreateSupportTicketSchema.safeParse(rawBody);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: TICKETS_ROUTE, action: "create" },
      });
    }
    const validatedData = result.data;

    const cleanDescription = stripCallbackTags(
      validatedData.description,
    ).trim();
    if (!cleanDescription) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        message: "Description is required",
        context: { route: TICKETS_ROUTE, action: "create" },
      });
    }
    const description = validatedData.callbackPhone
      ? `[Callback Requested: ${validatedData.callbackPhone}]\n\n${cleanDescription}`
      : cleanDescription;

    if (isSessionScopedIssueType(validatedData.issueType)) {
      return NextResponse.json(
        {
          error:
            "This issue is about a specific session — open the appointment and use 'Get help' so our team gets the session context.",
          code: "SESSION_SCOPED_ISSUE",
        },
        { status: 422 },
      );
    }

    const links = await resolveTicketEntityLinks(
      session.user.id,
      validatedData,
    );
    if (!links.ok) return links.response;

    if (validatedData.paymentId) {
      const existing = await findOpenTicketForPayment(
        session.user.id,
        validatedData.paymentId,
      );
      if (existing) {
        return NextResponse.json(existing, { status: 200 });
      }
    }

    let organizationId: string | null = null;
    if (validatedData.organizationId) {
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

    const ticket = await createSupportTicket({
      userId: session.user.id,
      title: validatedData.title,
      description,
      priority: validatedData.priority || "MEDIUM",
      category: validatedData.category,
      issueType: validatedData.issueType,
      organizationId,
      consultationId: links.consultationId,
      subscriptionId: links.subscriptionId,
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
