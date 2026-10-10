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
  type Tx,
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

function loadThread(threadId: string) {
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

async function persistStaffReplyTx(
  tx: Tx,
  thread: {
    id: string;
    supportTicketId: string | null;
    supportTicket: { assignedToId: string | null } | null;
  },
  staffUserId: string,
  message: string,
  now: Date,
) {
  const touched = await tx.appointmentSupportThread.updateMany({
    where: { id: thread.id, status: { not: "CLOSED" } },
    data: { lastMessageAt: now },
  });
  if (touched.count === 0) return null;

  const seq = await allocateMessageSeq(tx, thread.id, 1);
  const agentMessage = await tx.supportMessage.create({
    data: {
      threadId: thread.id,
      sender: "AGENT",
      body: message,
      seq: seq + 1,
      authorUserId: staffUserId,
    },
  });

  if (thread.supportTicketId) {
    await tx.supportResponse.create({
      data: {
        message,
        isInternal: false,
        supportTicketId: thread.supportTicketId,
        userId: staffUserId,
      },
    });
    await tx.supportTicket.updateMany({
      where: { id: thread.supportTicketId, status: "OPEN" },
      data: {
        status: "IN_PROGRESS",
        assignedToId: thread.supportTicket?.assignedToId ?? staffUserId,
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
}

async function notifyThreadReplyCustomer(params: {
  ticketId: string;
  userId: string;
  organizationId: string | null;
  referenceNumber: string | null | undefined;
  title: string | null | undefined;
  respondedBy: string;
  message: string;
  replyId: string;
}): Promise<void> {
  const dashboardUrl = supportRequestHref(
    caseKeyOf({ kind: "ticket", id: params.ticketId }),
    params.organizationId,
  );
  const reference = params.referenceNumber ?? undefined;
  const ticketTitle = params.title ?? "Support";

  await Promise.all([
    notifySupportTicketResponse(
      params.userId,
      {
        ticketId: params.ticketId,
        reference,
        ticketTitle,
        message: params.message,
        respondedBy: params.respondedBy,
        dashboardUrl,
        ...notificationScope(params.organizationId),
      },
      `thread-resp:${params.replyId}`,
    ),
    sendSupportTicketResponseEmail(
      {
        ticketId: params.ticketId,
        ownerUserId: params.userId,
        reference,
        title: ticketTitle,
        respondedBy: params.respondedBy,
        replyText: params.message,
        ticketUrl: dashboardUrl,
      },
      EMAIL_BUDGET_MS.REQUEST,
    ),
  ]);
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
      (tx) => persistStaffReplyTx(tx, thread, session.user.id, message, now),
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
      await notifyThreadReplyCustomer({
        ticketId: thread.supportTicketId,
        userId: thread.userId,
        organizationId: thread.organizationId,
        referenceNumber: thread.supportTicket?.referenceNumber,
        title: thread.supportTicket?.title,
        respondedBy: session.user.name ?? "Support",
        message,
        replyId: result.id,
      });
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

type ThreadLifecycleStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

function buildLinkedTicketStatusData(
  linked: {
    resolvedAt: Date | null;
    awaitingUserSince: Date | null;
    pausedSeconds: number;
  } | null,
  status: ThreadLifecycleStatus,
  isReopening: boolean,
  now: Date,
) {
  const pauseBank =
    linked?.awaitingUserSince !== null &&
    linked?.awaitingUserSince !== undefined
      ? {
          awaitingUserSince: null,
          pausedSeconds:
            linked.pausedSeconds +
            Math.max(
              0,
              Math.floor(
                (now.getTime() - linked.awaitingUserSince.getTime()) / 1000,
              ),
            ),
        }
      : {};
  return {
    status,
    lastMessageAt: now,
    ...pauseBank,
    ...(status === "RESOLVED" ? { resolvedAt: now } : {}),
    ...(status === "CLOSED"
      ? { closedAt: now, resolvedAt: linked?.resolvedAt ?? now }
      : {}),
    ...(isReopening ? { resolvedAt: null, closedAt: null } : {}),
  };
}

async function persistThreadStatusTx(
  tx: Tx,
  thread: { id: string; supportTicketId: string | null },
  status: ThreadLifecycleStatus,
  isReopening: boolean,
  now: Date,
): Promise<number> {
  const linked = thread.supportTicketId
    ? await tx.supportTicket.findUnique({
        where: { id: thread.supportTicketId },
        select: {
          status: true,
          resolvedAt: true,
          awaitingUserSince: true,
          pausedSeconds: true,
        },
      })
    : null;
  if (!isReopening && linked?.status === "CLOSED" && status !== "CLOSED") {
    return 0;
  }

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
    await tx.supportTicket.updateMany({
      where: {
        id: thread.supportTicketId,
        status: isReopening
          ? { in: ["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED"] }
          : { notIn: ["CLOSED"] },
      },
      data: buildLinkedTicketStatusData(linked, status, isReopening, now),
    });
  }
  return updated.count;
}

async function notifyThreadStatusCustomer(params: {
  threadId: string;
  ticketId: string;
  userId: string;
  organizationId: string | null;
  referenceNumber: string | null | undefined;
  title: string | null | undefined;
  status: ThreadLifecycleStatus;
  now: Date;
}): Promise<void> {
  const dashboardUrl = supportRequestHref(
    caseKeyOf({ kind: "ticket", id: params.ticketId }),
    params.organizationId,
  );
  const reference = params.referenceNumber ?? undefined;
  const ticketTitle = params.title ?? "Support";
  const statusLabel = supportTicketStatusLabel(params.status);

  await Promise.all([
    notifySupportTicketUpdate(
      params.userId,
      {
        ticketId: params.ticketId,
        reference,
        ticketTitle,
        status: statusLabel,
        statusCode: params.status,
        dashboardUrl,
        ...notificationScope(params.organizationId),
      },
      `thread-status:${params.threadId}:${params.status}:${params.now.getTime()}`,
    ),
    sendSupportTicketUpdateEmail(
      {
        ticketId: params.ticketId,
        ownerUserId: params.userId,
        reference,
        title: ticketTitle,
        statusCode: params.status,
        statusLabel,
        ticketUrl: dashboardUrl,
      },
      EMAIL_BUDGET_MS.REQUEST,
    ),
  ]);
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
    const updatedCount = await prisma.$transaction((tx) =>
      persistThreadStatusTx(tx, thread, status, isReopening, now),
    );
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
      await notifyThreadStatusCustomer({
        threadId: thread.id,
        ticketId: thread.supportTicketId,
        userId: thread.userId,
        organizationId: thread.organizationId,
        referenceNumber: thread.supportTicket?.referenceNumber,
        title: thread.supportTicket?.title,
        status,
        now,
      });
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
