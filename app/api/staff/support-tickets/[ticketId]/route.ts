/**
 * Staff Support Ticket Detail API
 * Get ticket details and update ticket (status, priority, assignment)
 */

import { NextRequest, NextResponse } from "next/server";
import { supportError } from "@/lib/api/support-http";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { Prisma, UserRole } from "@prisma/client";
import { notifySupportTicketUpdate } from "@/lib/novu";
import { EMAIL_BUDGET_MS, sendSupportTicketUpdateEmail } from "@/lib/email";
import { notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "@/lib/support/case-key";
import { withSupportAttachmentHrefs } from "@/lib/support/attachment-href";
import { supportTicketStatusLabel } from "@/lib/novu/humanize";
import { UpdateSupportTicketSchema } from "@/schemas/support";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";
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
        // #support-hub — the escalated-from thread, transcript included: staff
        // are the HUMAN channel's counterparty, so the conversation is theirs
        // to read (unlike the org triage surface, which is metadata-only).
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

    return NextResponse.json({
      ...ticket,
      attachments: withSupportAttachmentHrefs(ticket.attachments),
      // Transcript was fetched newest-50 for the bound; hand it back oldest-
      // first, the ascending shape the page has always rendered.
      ...(ticket.appointmentSupportThread
        ? {
            appointmentSupportThread: {
              ...ticket.appointmentSupportThread,
              messages: [...ticket.appointmentSupportThread.messages].reverse(),
            },
          }
        : {}),
      linkedConsultation,
      linkedSubscription,
      linkedPayment,
      linkedRefund,
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
  validatedData: Prisma.SupportTicketUncheckedUpdateManyInput & {
    status?: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | "RESOLVED" | "CLOSED";
  },
  existingResolvedAt: Date | null,
  now: Date,
): Prisma.SupportTicketUncheckedUpdateManyInput {
  const updateData: Prisma.SupportTicketUncheckedUpdateManyInput = {};

  if (validatedData.status) {
    updateData.status = validatedData.status;
    if (validatedData.status === "RESOLVED") {
      updateData.resolvedAt = now;
      updateData.closedAt = null;
    } else if (validatedData.status === "CLOSED") {
      updateData.closedAt = now;
      updateData.resolvedAt = existingResolvedAt ?? now;
    } else {
      updateData.resolvedAt = null;
      updateData.closedAt = null;
    }
  }

  if (validatedData.priority) {
    updateData.priority = validatedData.priority;
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

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { ticketId } = await params;
    const body: unknown = await req.json().catch(() => null);
    const result = UpdateSupportTicketSchema.safeParse(body);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: "staff.support-tickets", action: "update" },
      });
    }
    const validatedData = result.data;
    // ON_HOLD stays readable on existing rows but has no write path until it is a real feature.
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

    // Assignee and priority are frozen once closed; only a status change (reopen) is accepted.
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

    if (
      validatedData.assignedToId !== undefined &&
      validatedData.assignedToId !== null
    ) {
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

    const now = new Date();
    const updateData = buildTicketPatchFields(
      validatedData,
      existing.resolvedAt,
      now,
    );

    const updatedTicket = await prisma.$transaction(
      async (tx) => {
        const updated = await tx.supportTicket.updateMany({
          where: {
            id: ticketId,
            updatedAt: new Date(validatedData.expectedUpdatedAt),
            // Priority and assignee edits never land on a closed ticket.
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

    // After the commit — a notification failure must not roll back a status
    // change the queue has already acted on.
    // Notify the ticket owner about the update
    const reference = updatedTicket.referenceNumber ?? undefined;
    const ticketTitle = updatedTicket.title || "Support Ticket";
    const statusLabel = supportTicketStatusLabel(updatedTicket.status);
    const requestUrl = supportRequestHref(
      caseKeyOf({ kind: "ticket", id: updatedTicket.id }),
      updatedTicket.appointmentSupportThread?.organizationId,
    );
    await notifySupportTicketUpdate(updatedTicket.user.id, {
      ticketId: updatedTicket.id,
      reference,
      ticketTitle,
      status: statusLabel,
      statusCode: updatedTicket.status,
      dashboardUrl: requestUrl,
      // ADR 23 — inherit the ticket's org-ness (attribution only).
      ...notificationScope(updatedTicket.organizationId),
    });
    // #1653 — the email twin of the bell. The owner's address is loaded above,
    // but the sender reads it through the preference gate so the category
    // switch and the zone apply here as everywhere; it never throws.
    await sendSupportTicketUpdateEmail(
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
    );

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
