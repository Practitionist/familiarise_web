/**
 * #support-hub — Staff/Admin view of ONE per-appointment support thread.
 *
 * GET   → full transcript + requester + appointment summary + linked ticket.
 * POST  → agent reply. The message lands on the thread as AGENT (what the user
 *         sees in their conversation) AND is mirrored as a public
 *         SupportResponse on the linked ticket (so the ops queue's history and
 *         the user's "My requests" view stay complete). One notification, not
 *         two. CAS: OPEN→IN_PROGRESS on the ticket, thread stays ESCALATED.
 * PATCH → status change (RESOLVED / CLOSED / IN_PROGRESS), CAS-guarded,
 *         mirrored to the linked ticket when present.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  notifySupportTicketResponse,
  notifySupportTicketUpdate,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { supportTicketStatusLabel } from "@/lib/novu/humanize";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "@/lib/support/case-key";
import {
  EMAIL_BUDGET_MS,
  sendSupportTicketResponseEmail,
  sendSupportTicketUpdateEmail,
} from "@/lib/email";
import { SupportThreadIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import { MESSAGE_ORDER, allocateMessageSeq } from "@/lib/support/message-seq";
import { applyStaffReply } from "@/lib/support/sla";

const THREAD_ROUTE = "staff.support-thread";

interface RouteParams {
  params: Promise<{ threadId: string }>;
}

const replySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  expectedLastMessageAt: z.string().datetime().optional(),
});

const patchSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
});

async function loadThread(threadId: string) {
  return prisma.appointmentSupportThread.findUnique({
    where: { id: threadId },
    include: {
      user: {
        select: { id: true, name: true, email: true, image: true, phone: true },
      },
      messages: { orderBy: MESSAGE_ORDER },
      supportTicket: { select: { id: true, title: true, status: true } },
      appointment: {
        select: {
          id: true,
          appointmentType: true,
          occurrences: {
            orderBy: { startsAt: "asc" },
            take: 1,
            select: { startsAt: true, endsAt: true },
          },
          consultation: {
            select: { consultationPlan: { select: { title: true } } },
          },
          subscription: {
            select: { subscriptionPlan: { select: { title: true } } },
          },
          webinar: { select: { webinarPlan: { select: { title: true } } } },
          class: { select: { classPlan: { select: { title: true } } } },
        },
      },
    },
  });
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(SupportThreadIdParams, params, {
    route: THREAD_ROUTE,
  });
  if (!id.ok) return id.response;
  const { threadId } = id.data;
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const thread = await loadThread(threadId);
    if (!thread) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "Thread not found",
        context: { route: THREAD_ROUTE, action: "get", threadId },
      });
    }
    return NextResponse.json({ data: thread });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: THREAD_ROUTE, action: "get", threadId },
    });
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(SupportThreadIdParams, params, {
    route: THREAD_ROUTE,
  });
  if (!id.ok) return id.response;
  const { threadId } = id.data;
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const parsed = replySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: THREAD_ROUTE, action: "reply", threadId },
      });
    }
    const { message, expectedLastMessageAt } = parsed.data;

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { id: threadId },
      include: {
        supportTicket: {
          select: {
            id: true,
            title: true,
            referenceNumber: true,
            status: true,
            assignedToId: true,
            acknowledgedAt: true,
            firstAgentReplyAt: true,
          },
        },
      },
    });
    if (!thread) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "Thread not found",
        context: { route: THREAD_ROUTE, action: "reply", threadId },
      });
    }

    if (thread.status === "CLOSED") {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        message: "Cannot reply to a closed support thread",
        context: { route: THREAD_ROUTE, action: "reply", threadId },
      });
    }

    if (
      expectedLastMessageAt &&
      thread.lastMessageAt &&
      thread.lastMessageAt.getTime() > new Date(expectedLastMessageAt).getTime()
    ) {
      return NextResponse.json(
        {
          code: "NEW_CUSTOMER_MESSAGE",
          error:
            "Customer replied since you opened this case. Review their message before sending.",
        },
        { status: 409 },
      );
    }

    const now = new Date();
    const result = await prisma.$transaction(
      async (tx) => {
        const touched = await tx.appointmentSupportThread.updateMany({
          where: { id: thread.id, status: { not: "CLOSED" } },
          data: { lastMessageAt: now },
        });
        if (touched.count === 0) {
          return null;
        }
        const seq = await allocateMessageSeq(tx, thread.id, 1);
        const agentMessage = await tx.supportMessage.create({
          data: {
            threadId: thread.id,
            sender: "AGENT",
            body: message,
            seq: seq + 1,
            authorUserId: session.user.id,
          },
        });

        if (thread.supportTicketId) {
          await tx.supportResponse.create({
            data: {
              message,
              isInternal: false,
              supportTicketId: thread.supportTicketId,
              userId: session.user.id,
            },
          });
          await tx.supportTicket.updateMany({
            where: { id: thread.supportTicketId, status: "OPEN" },
            data: {
              status: "IN_PROGRESS",
              assignedToId:
                thread.supportTicket?.assignedToId ?? session.user.id,
              lastMessageAt: now,
            },
          });
          await applyStaffReply(tx, thread.supportTicketId, now);
          await tx.supportTicket.update({
            where: { id: thread.supportTicketId },
            data: { lastMessageAt: now },
          });
        }
        return agentMessage;
      },
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );

    if (!result) {
      return supportError({
        status: 409,
        code: "CONFLICT",
        message: "Cannot reply to a closed support thread",
        context: { route: THREAD_ROUTE, action: "reply", threadId },
      });
    }

    if (thread.supportTicketId) {
      const dashboardUrl = supportRequestHref(
        caseKeyOf({ kind: "ticket", id: thread.supportTicketId }),
        thread.organizationId,
      );
      const reference = thread.supportTicket?.referenceNumber ?? undefined;
      const ticketTitle = thread.supportTicket?.title ?? "Support";
      const respondedBy = session.user.name ?? "Support";
      await notifySupportTicketResponse(
        thread.userId,
        {
          ticketId: thread.supportTicketId,
          reference,
          ticketTitle,
          message,
          respondedBy,
          dashboardUrl,
          ...notificationScope(thread.organizationId),
        },
        `thread-resp:${result.id}`,
      );
      await sendSupportTicketResponseEmail(
        {
          ticketId: thread.supportTicketId,
          ownerUserId: thread.userId,
          reference,
          title: ticketTitle,
          respondedBy,
          replyText: message,
          ticketUrl: dashboardUrl,
        },
        EMAIL_BUDGET_MS.REQUEST,
      );
    }

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: THREAD_ROUTE, action: "reply", threadId },
    });
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(SupportThreadIdParams, params, {
    route: THREAD_ROUTE,
  });
  if (!id.ok) return id.response;
  const { threadId } = id.data;
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: THREAD_ROUTE, action: "status", threadId },
      });
    }
    const { status } = parsed.data;
    const isReopening = status === "OPEN" || status === "IN_PROGRESS";

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        supportTicketId: true,
        status: true,
        userId: true,
        organizationId: true,
        supportTicket: { select: { title: true, referenceNumber: true } },
      },
    });
    if (!thread) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "Thread not found",
        context: { route: THREAD_ROUTE, action: "status", threadId },
      });
    }

    const now = new Date();
    const updatedCount = await prisma.$transaction(async (tx) => {
      const updated = await tx.appointmentSupportThread.updateMany({
        where: {
          id: thread.id,
          status: isReopening
            ? { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "RESOLVED", "CLOSED"] }
            : { notIn: ["CLOSED"] },
        },
        data: {
          status,
          ...(status === "RESOLVED" ? { resolvedAt: now } : {}),
          ...(isReopening ? { resolvedAt: null } : {}),
        },
      });
      if (updated.count === 0) return 0;

      if (thread.supportTicketId) {
        const linked = await tx.supportTicket.findUnique({
          where: { id: thread.supportTicketId },
          select: { status: true, resolvedAt: true },
        });
        if (
          !isReopening &&
          linked?.status === "CLOSED" &&
          status !== "CLOSED"
        ) {
          return 0;
        }
        await tx.supportTicket.updateMany({
          where: {
            id: thread.supportTicketId,
            status: isReopening
              ? { in: ["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED"] }
              : { notIn: ["CLOSED"] },
          },
          data: {
            status,
            lastMessageAt: now,
            ...(status === "RESOLVED" ? { resolvedAt: now } : {}),
            ...(status === "CLOSED"
              ? { closedAt: now, resolvedAt: linked?.resolvedAt ?? now }
              : {}),
            ...(isReopening ? { resolvedAt: null, closedAt: null } : {}),
          },
        });
      }
      return updated.count;
    });
    if (updatedCount === 0) {
      return supportError({
        status: 409,
        code: "CONFLICT",
        message:
          "This conversation can no longer change status — it, or the ticket behind it, is already closed",
        context: {
          route: THREAD_ROUTE,
          action: "status",
          threadId,
          attemptedStatus: status,
        },
      });
    }

    if (thread.supportTicketId) {
      const dashboardUrl = supportRequestHref(
        caseKeyOf({ kind: "ticket", id: thread.supportTicketId }),
        thread.organizationId,
      );
      const reference = thread.supportTicket?.referenceNumber ?? undefined;
      const ticketTitle = thread.supportTicket?.title ?? "Support";
      const statusLabel = supportTicketStatusLabel(status);
      await notifySupportTicketUpdate(
        thread.userId,
        {
          ticketId: thread.supportTicketId,
          reference,
          ticketTitle,
          status: statusLabel,
          statusCode: status,
          dashboardUrl,
          ...notificationScope(thread.organizationId),
        },
        `thread-status:${thread.id}:${status}:${now.getTime()}`,
      );
      await sendSupportTicketUpdateEmail(
        {
          ticketId: thread.supportTicketId,
          ownerUserId: thread.userId,
          reference,
          title: ticketTitle,
          statusCode: status,
          statusLabel,
          ticketUrl: dashboardUrl,
        },
        EMAIL_BUDGET_MS.REQUEST,
      );
    }

    return NextResponse.json({ data: { id: thread.id, status } });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: THREAD_ROUTE, action: "status", threadId },
    });
  }
}
