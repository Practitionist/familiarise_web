import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { CreateSupportTicketSchema } from "@/schemas/support";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
import { allocateTicketReference } from "@/lib/support/reference";
import { slaDeadlinesFor } from "@/lib/support/sla";
import { notifySupportTicketResponse } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "@/lib/support/case-key";
import { reportSentryError } from "@/lib/observability/report";

const STAFF_OUTBOUND_ROUTE = "staff.support-tickets";

const OutboundSupportTicketSchema = CreateSupportTicketSchema.extend({
  targetUserId: z.string().trim().min(1).max(200),
});

async function resolveTargetUserId(
  targetLookup: string,
): Promise<string | null> {
  const targetUser = targetLookup.includes("@")
    ? await prisma.user.findFirst({
        where: { email: { equals: targetLookup, mode: "insensitive" } },
        select: { id: true },
      })
    : await prisma.user.findUnique({
        where: { id: targetLookup },
        select: { id: true },
      });
  return targetUser?.id ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("tickets.manage");
    if (auth.error) return auth.error;
    const { session } = auth;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const rawBody = await req.json().catch(() => null);
    const result = OutboundSupportTicketSchema.safeParse(rawBody);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: STAFF_OUTBOUND_ROUTE, action: "create" },
      });
    }
    const validatedData = result.data;

    const ticketUserId = await resolveTargetUserId(validatedData.targetUserId);
    if (!ticketUserId) {
      return NextResponse.json(
        {
          error: "Target user not found.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    const [validMembership, validPayment] = await Promise.all([
      validatedData.organizationId
        ? prisma.membership.findFirst({
            where: {
              organizationId: validatedData.organizationId,
              userId: ticketUserId,
              status: "ACTIVE",
            },
            select: { organizationId: true },
          })
        : null,
      validatedData.paymentId
        ? prisma.payment.findFirst({
            where: {
              id: validatedData.paymentId,
              userId: ticketUserId,
            },
            select: { id: true },
          })
        : null,
    ]);

    const resolvedOrganizationId = validMembership?.organizationId ?? null;
    const resolvedPaymentId = validPayment?.id ?? null;
    const priority = validatedData.priority || "MEDIUM";

    const ticket = await prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const referenceNumber = await allocateTicketReference(tx, now);
        const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(priority, now);

        const created = await tx.supportTicket.create({
          data: {
            userId: ticketUserId,
            assignedToId: session.user.id,
            status: "IN_PROGRESS",
            title: validatedData.title,
            description: validatedData.description,
            priority,
            referenceNumber,
            ackDueAt,
            resolutionDueAt,
            acknowledgedAt: now,
            firstAgentReplyAt: now,
            awaitingUserSince: now,
            lastMessageAt: now,
            category: validatedData.category ?? undefined,
            issueType: validatedData.issueType ?? "GENERAL_INQUIRY",
            organizationId: resolvedOrganizationId ?? undefined,
            paymentId: resolvedPaymentId ?? undefined,
          },
        });

        await tx.supportResponse.create({
          data: {
            message: validatedData.description,
            isInternal: false,
            supportTicket: { connect: { id: created.id } },
            user: { connect: { id: session.user.id } },
          },
        });

        return created;
      },
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );

    await notifySupportTicketResponse(ticket.userId, {
      ticketId: ticket.id,
      reference: ticket.referenceNumber ?? undefined,
      ticketTitle: ticket.title || "Support Ticket",
      message: validatedData.description,
      respondedBy: session.user.name ?? "Support",
      dashboardUrl: supportRequestHref(
        caseKeyOf({ kind: "ticket", id: ticket.id }),
        resolvedOrganizationId,
      ),
      ...notificationScope(resolvedOrganizationId),
    }).catch((err) => {
      reportSentryError(err, {
        subsystem: "support",
        op: "outbound.notifyUser",
        extra: { ticketId: ticket.id },
      });
    });

    return NextResponse.json(ticket, { status: 201 });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: STAFF_OUTBOUND_ROUTE, action: "create" },
    });
  }
}
