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
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { notifySupportTicketResponse } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { SupportThreadIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";

const THREAD_ROUTE = "staff.support-thread";

interface RouteParams {
  params: Promise<{ threadId: string }>;
}

const replySchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

const patchSchema = z.object({
  status: z.enum(["IN_PROGRESS", "RESOLVED", "CLOSED"]),
});

async function loadThread(threadId: string) {
  return prisma.appointmentSupportThread.findUnique({
    where: { id: threadId },
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
      messages: { orderBy: { createdAt: "asc" } },
      supportTicket: { select: { id: true, title: true, status: true } },
      appointment: {
        select: {
          id: true,
          appointmentType: true,
          slotsOfAppointment: {
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
    const { message } = parsed.data;

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { id: threadId },
      include: { supportTicket: { select: { id: true, title: true, status: true, assignedToId: true } } },
    });
    if (!thread) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "Thread not found",
        context: { route: THREAD_ROUTE, action: "reply", threadId },
      });
    }

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      // The user-facing message on the thread…
      const agentMessage = await tx.supportMessage.create({
        data: { threadId: thread.id, sender: "AGENT", body: message },
      });
      await tx.appointmentSupportThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: now },
      });

      // …mirrored as a public response on the linked ticket (if any), so the
      // queue's history and the user's requests view stay one story.
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
          // CAS: a concurrent staff move off OPEN must not be clobbered.
          where: { id: thread.supportTicketId, status: "OPEN" },
          data: {
            status: "IN_PROGRESS",
            assignedToId: thread.supportTicket?.assignedToId ?? session.user.id,
            lastMessageAt: now,
          },
        });
      }
      return agentMessage;
    });

    if (thread.supportTicketId) {
      void notifySupportTicketResponse(thread.userId, {
        ticketId: thread.supportTicketId,
        ticketTitle: thread.supportTicket?.title ?? "Support",
        message,
        respondedBy: session.user.name ?? "Support",
        // Deep-link into the appointment detail where the thread lives.
        dashboardUrl: `/dashboard`,
        // ADR 23 — inherit the thread's org-ness (attribution only).
        ...notificationScope(thread.organizationId),
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

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { id: threadId },
      select: { id: true, supportTicketId: true, status: true },
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
    // CAS on the thread's own status: the WHERE clause is the transition rule.
    const updated = await prisma.appointmentSupportThread.updateMany({
      where: { id: thread.id, status: { notIn: ["CLOSED"] } },
      data: {
        status,
        resolvedAt: status === "RESOLVED" ? now : null,
      },
    });
    if (updated.count === 0) {
      return supportError({
        status: 409,
        code: "CONFLICT",
        message: "Thread is closed and can no longer change status",
        context: { route: THREAD_ROUTE, action: "status", threadId, attemptedStatus: status },
      });
    }

    // Mirror to the linked ticket so the queue never disagrees with the thread.
    if (thread.supportTicketId) {
      await prisma.supportTicket.updateMany({
        where: { id: thread.supportTicketId, status: { notIn: ["CLOSED"] } },
        data: { status, lastMessageAt: now },
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
