/**
 * Staff Support Ticket Detail API
 * Get ticket details and update ticket (status, priority, assignment)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supportError } from "@/lib/api/support-http";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { Prisma, UserRole } from "@prisma/client";
import { notifySupportTicketUpdate } from "@/lib/novu";
import { stageBell } from "@/lib/novu/stage-bell";
import { EMAIL_BUDGET_MS, sendSupportTicketUpdateEmail } from "@/lib/email";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "@/lib/support/case-key";
import { withSupportAttachmentHrefs } from "@/lib/support/attachment-href";
import { supportTicketStatusLabel } from "@/lib/novu/humanize";
import {
  tightenDeadlinesForPriorityRaise,
  userRepliedPatch,
} from "@/lib/support/sla";
import { MAX_TEXT_LENGTH } from "@/lib/validation/limits";
import { UpdateSupportTicketSchema } from "@/schemas/support";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";

const TWENTY_FOUR_HOURS_MS = 24 * 3_600_000;

const StaffPatchSupportTicketSchema = UpdateSupportTicketSchema.extend({
  note: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
});

interface RouteParams {
  params: Promise<{ ticketId: string }>;
}

async function loadTicketLinkedEntities(ticket: {
  consultationId: string | null;
  subscriptionId: string | null;
  paymentId: string | null;
  refundId: string | null;
}) {
  const [linkedConsultation, linkedSubscription, linkedPayment, linkedRefund] =
    await Promise.all([
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
                    select: {
                      ...consultantPublicScalars,
                      user: { select: { name: true, email: true } },
                    },
                  },
                },
              },
              appointment: {
                select: {
                  id: true,
                  occurrences: {
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
                    select: {
                      ...consultantPublicScalars,
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
              amountPaise: true,
              currency: true,
              status: true,
              reason: true,
              createdAt: true,
            },
          })
        : Promise.resolve(null),
    ]);

  return {
    linkedConsultation,
    linkedSubscription,
    linkedPayment,
    linkedRefund,
  };
}

/**
 * GET /api/staff/support-tickets/[ticketId]
 * Get full ticket details with responses, attachments, and linked entities
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
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
        appointmentSupportThread: {
          select: {
            id: true,
            category: true,
            status: true,
            activeChannel: true,
            createdAt: true,
            lastMessageAt: true,
            messages: {
              orderBy: [{ seq: "desc" }, { createdAt: "desc" }],
              take: 50,
              select: { id: true, sender: true, body: true, createdAt: true },
            },
          },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    const linkedEntities = await loadTicketLinkedEntities(ticket);

    return NextResponse.json({
      ...ticket,
      attachments: withSupportAttachmentHrefs(ticket.attachments),
      ...(ticket.appointmentSupportThread
        ? {
            appointmentSupportThread: {
              ...ticket.appointmentSupportThread,
              messages: [...ticket.appointmentSupportThread.messages].reverse(),
            },
          }
        : {}),
      ...linkedEntities,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
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
function buildTicketPatchFields(
  validatedData: z.infer<typeof StaffPatchSupportTicketSchema>,
  existing: {
    priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    ackDueAt: Date | null;
    acknowledgedAt: Date | null;
    resolutionDueAt: Date | null;
    resolvedAt: Date | null;
    awaitingUserSince: Date | null;
    pausedSeconds: number;
  },
  now: Date,
): Prisma.SupportTicketUncheckedUpdateManyInput {
  const updateData: Prisma.SupportTicketUncheckedUpdateManyInput = {};

  if (validatedData.status) {
    updateData.status = validatedData.status;
    if (existing.awaitingUserSince !== null) {
      Object.assign(updateData, userRepliedPatch(existing, now));
    }
    if (validatedData.status === "RESOLVED") {
      updateData.resolvedAt = now;
      updateData.closedAt = null;
    } else if (validatedData.status === "CLOSED") {
      updateData.closedAt = now;
      updateData.resolvedAt = existing.resolvedAt ?? now;
    } else {
      updateData.resolvedAt = null;
      updateData.closedAt = null;
    }
  }

  if (validatedData.priority) {
    updateData.priority = validatedData.priority;
    const tightened = tightenDeadlinesForPriorityRaise(
      existing,
      validatedData.priority,
      now,
    );
    if (tightened.ackDueAt) updateData.ackDueAt = tightened.ackDueAt;
    if (tightened.resolutionDueAt) {
      updateData.resolutionDueAt = tightened.resolutionDueAt;
    }
  }

  if (validatedData.assignedToId !== undefined) {
    updateData.assignedToId = validatedData.assignedToId;
  }

  if (validatedData.refundId) {
    updateData.refundId = validatedData.refundId;
  }

  return updateData;
}

async function syncLinkedThreadStatus(
  tx: Tx,
  ticketId: string,
  existingStatus: string,
  nextStatus:
    "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "RESOLVED" | "CLOSED" | undefined,
  now: Date,
): Promise<void> {
  if (existingStatus === "CLOSED" && nextStatus && nextStatus !== "CLOSED") {
    await tx.appointmentSupportThread.updateMany({
      where: { supportTicketId: ticketId, status: "CLOSED" },
      data: { status: "ESCALATED", resolvedAt: null },
    });
    return;
  }
  if (nextStatus === "OPEN") {
    await tx.appointmentSupportThread.updateMany({
      where: {
        supportTicketId: ticketId,
        status: { notIn: ["CLOSED"] },
      },
      data: {
        status: "ESCALATED",
        resolvedAt: null,
      },
    });
    return;
  }
  if (nextStatus && nextStatus !== "ON_HOLD") {
    await tx.appointmentSupportThread.updateMany({
      where: {
        supportTicketId: ticketId,
        status: { notIn: ["CLOSED"] },
      },
      data: {
        status: nextStatus,
        ...(nextStatus === "RESOLVED" ? { resolvedAt: now } : {}),
        ...(nextStatus === "IN_PROGRESS" ? { resolvedAt: null } : {}),
      },
    });
  }
}

async function recordTicketAuditEvents(
  tx: Tx,
  ticketId: string,
  actorId: string,
  validatedData: z.infer<typeof StaffPatchSupportTicketSchema>,
  existing: {
    status: string;
    priority: string;
    assignedToId: string | null;
  },
  trimmedNote: string | null,
  now: Date,
): Promise<void> {
  const ops: Promise<unknown>[] = [];

  if (trimmedNote) {
    ops.push(
      tx.supportResponse.create({
        data: {
          message: trimmedNote,
          isInternal: true,
          supportTicket: { connect: { id: ticketId } },
          user: { connect: { id: actorId } },
        },
      }),
    );
  }

  if (validatedData.status && validatedData.status !== existing.status) {
    const wasSettled =
      existing.status === "RESOLVED" || existing.status === "CLOSED";
    const isReopenTarget =
      validatedData.status === "OPEN" || validatedData.status === "IN_PROGRESS";
    ops.push(
      tx.supportCaseEvent.create({
        data: {
          legacyTicketId: ticketId,
          actorId,
          kind: wasSettled && isReopenTarget ? "REOPENED" : "STATUS_CHANGED",
          fromValue: existing.status,
          toValue: validatedData.status,
          createdAt: now,
        },
      }),
    );
  }

  if (validatedData.priority && validatedData.priority !== existing.priority) {
    ops.push(
      tx.supportCaseEvent.create({
        data: {
          legacyTicketId: ticketId,
          actorId,
          kind: "PRIORITY_CHANGED",
          fromValue: existing.priority,
          toValue: validatedData.priority,
          createdAt: now,
        },
      }),
    );
  }

  if (
    validatedData.assignedToId !== undefined &&
    validatedData.assignedToId !== existing.assignedToId
  ) {
    ops.push(
      tx.supportCaseEvent.create({
        data: {
          legacyTicketId: ticketId,
          actorId,
          kind: validatedData.assignedToId ? "ASSIGNED" : "UNASSIGNED",
          fromValue: existing.assignedToId,
          toValue: validatedData.assignedToId,
          note: trimmedNote,
          createdAt: now,
        },
      }),
    );
  }

  if (ops.length > 0) {
    await Promise.all(ops);
  }
}

async function notifyTicketCustomerStatusChange(
  updatedTicket: {
    id: string;
    referenceNumber: string | null;
    title: string;
    status: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "RESOLVED" | "CLOSED";
    organizationId: string | null;
    user: { id: string };
    appointmentSupportThread: { organizationId: string | null } | null;
  },
  now: Date,
): Promise<void> {
  const reference = updatedTicket.referenceNumber ?? undefined;
  const ticketTitle = updatedTicket.title || "Support Ticket";
  const statusLabel = supportTicketStatusLabel(updatedTicket.status);
  const requestUrl = supportRequestHref(
    caseKeyOf({ kind: "ticket", id: updatedTicket.id }),
    updatedTicket.appointmentSupportThread?.organizationId,
  );

  await Promise.all([
    notifySupportTicketUpdate(
      updatedTicket.user.id,
      {
        ticketId: updatedTicket.id,
        reference,
        ticketTitle,
        status: statusLabel,
        statusCode: updatedTicket.status,
        dashboardUrl: requestUrl,
        ...notificationScope(updatedTicket.organizationId),
      },
      `ticket-status:${updatedTicket.id}:${updatedTicket.status}:${now.getTime()}`,
    ),
    sendSupportTicketUpdateEmail(
      {
        ticketId: updatedTicket.id,
        ownerUserId: updatedTicket.user.id,
        reference,
        title: ticketTitle,
        statusCode: updatedTicket.status,
        statusLabel,
        ticketUrl: requestUrl,
      },
      EMAIL_BUDGET_MS.REQUEST,
    ),
  ]);
}

async function validateStaffTicketAssignee(
  assignedToId: string | null | undefined,
): Promise<boolean> {
  if (assignedToId === undefined || assignedToId === null) return true;
  const assignee = await prisma.user.findUnique({
    where: { id: assignedToId },
    select: { role: true },
  });
  return Boolean(
    assignee &&
    (assignee.role === UserRole.STAFF || assignee.role === UserRole.ADMIN),
  );
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const actorId = auth.session.user.id;

    const { ticketId } = await params;
    const body: unknown = await req.json().catch(() => null);
    const result = StaffPatchSupportTicketSchema.safeParse(body);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: "staff.support-tickets", action: "update" },
      });
    }
    const validatedData = result.data;
    if (validatedData.status === "ON_HOLD") {
      return NextResponse.json(
        {
          error:
            "On hold isn't available yet; use 'Waiting on customer' or leave a note.",
          code: "STATUS_NOT_SUPPORTED",
        },
        { status: 400 },
      );
    }

    const existing = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    if (existing.status === "CLOSED" && !validatedData.status) {
      return NextResponse.json(
        {
          error:
            "This request is closed, so its assignee and priority can't be changed. Reopen it first.",
          code: "TICKET_CLOSED",
        },
        { status: 400 },
      );
    }

    if (!(await validateStaffTicketAssignee(validatedData.assignedToId))) {
      return NextResponse.json(
        { error: "Invalid assignee - must be staff or admin" },
        { status: 400 },
      );
    }

    const now = new Date();
    const updateData = buildTicketPatchFields(validatedData, existing, now);
    const trimmedNote = validatedData.note?.trim() || null;

    const updatedTicket = await prisma.$transaction(
      async (tx) => {
        const updated = await tx.supportTicket.updateMany({
          where: {
            id: ticketId,
            updatedAt: new Date(validatedData.expectedUpdatedAt),
            ...(validatedData.status ? {} : { status: { not: "CLOSED" } }),
          },
          data: updateData,
        });
        if (updated.count === 0) {
          return null;
        }

        await syncLinkedThreadStatus(
          tx,
          ticketId,
          existing.status,
          validatedData.status,
          now,
        );

        await recordTicketAuditEvents(
          tx,
          ticketId,
          actorId,
          validatedData,
          existing,
          trimmedNote,
          now,
        );

        if (
          validatedData.status === "RESOLVED" &&
          existing.status !== "RESOLVED"
        ) {
          const csatDedupeKey = `csat:${ticketId}:${now.toISOString()}`;
          const csatArgs = {
            workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
            recipients: [existing.userId],
            payload: {
              ticketId,
              reference: existing.referenceNumber ?? undefined,
              ticketTitle: existing.title || "Support Ticket",
              status: "Resolved — rate your resolution",
              statusCode: "RESOLVED",
              dashboardUrl: supportRequestHref(
                caseKeyOf({ kind: "ticket", id: ticketId }),
                existing.organizationId,
              ),
              ...notificationScope(existing.organizationId),
            },
            dedupeKey: csatDedupeKey,
            entityRef: csatDedupeKey,
            notBefore: new Date(now.getTime() + TWENTY_FOUR_HOURS_MS),
          };
          await stageBell(tx, csatArgs);
        }

        return tx.supportTicket.findUniqueOrThrow({
          where: { id: ticketId },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            appointmentSupportThread: { select: { organizationId: true } },
          },
        });
      },
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );

    if (!updatedTicket) {
      return NextResponse.json(
        {
          error: "Ticket was modified concurrently; please retry.",
          code: "CONFLICT",
        },
        { status: 409 },
      );
    }

    if (existing.status !== updatedTicket.status) {
      await notifyTicketCustomerStatusChange(updatedTicket, now);
    }

    return NextResponse.json(updatedTicket);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error updating support ticket:", error);
    return NextResponse.json(
      { error: "Failed to update support ticket" },
      { status: 500 },
    );
  }
}
