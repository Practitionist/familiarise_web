/**
 * #support-hub — Staff/Admin SUPPORT THREADS inbox.
 *
 * The ops-side view over per-appointment support conversations. Staff are the
 * counterparty in the HUMAN channel, so unlike the org triage surface this
 * reads FULL transcripts — that is the support function, not an ADR-20 leak
 * (the boundary there governs organizations watching their members).
 *
 * GET /api/staff/support-threads        — filterable list + status counts
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import type { Prisma } from "@prisma/client";

const STAFF_THREADS_ROUTE = "staff.support-threads";

const QuerySchema = z.object({
  status: z
    .enum(["OPEN", "IN_PROGRESS", "ESCALATED", "RESOLVED", "CLOSED"])
    .optional(),
  channel: z.enum(["AI", "HUMAN"]).optional(),
  category: z
    .enum([
      "CANCEL_REFUND",
      "RESCHEDULE",
      "NO_SHOW",
      "TECHNICAL",
      "PAYMENT_STATUS",
      "RECORDING_ACCESS",
      "QUALITY_COMPLAINT",
      "SPONSORSHIP_BILLING",
      "ORG_ADMIN_DISPUTE",
      "OTHER",
    ])
    .optional(),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const query = QuerySchema.safeParse({
      status: searchParams.get("status") ?? undefined,
      channel: searchParams.get("channel") ?? undefined,
      category: searchParams.get("category") ?? undefined,
    });
    if (!query.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: query.error.flatten(),
        context: { route: STAFF_THREADS_ROUTE },
      });
    }
    const search = searchParams.get("search");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "20")));
    const offset = (page - 1) * limit;

    const where: Prisma.AppointmentSupportThreadWhereInput = {};
    if (query.data.status) where.status = query.data.status;
    if (query.data.channel) where.activeChannel = query.data.channel;
    if (query.data.category) where.category = query.data.category;
    if (search) {
      where.OR = [
        { id: { contains: search, mode: "insensitive" } },
        { appointmentId: { contains: search, mode: "insensitive" } },
        { user: { name: { contains: search, mode: "insensitive" } } },
        { user: { email: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [threads, total, counts] = await Promise.all([
      prisma.appointmentSupportThread.findMany({
        where,
        orderBy: [
          { lastMessageAt: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        skip: offset,
        take: limit,
        select: {
          id: true,
          appointmentId: true,
          category: true,
          status: true,
          activeChannel: true,
          lastMessageAt: true,
          createdAt: true,
          resolvedAt: true,
          supportTicketId: true,
          organizationId: true,
          user: { select: { id: true, name: true, email: true, image: true } },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { sender: true, body: true, createdAt: true },
          },
          _count: { select: { messages: true } },
        },
      }),
      prisma.appointmentSupportThread.count({ where }),
      prisma.appointmentSupportThread.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    ]);

    return NextResponse.json({
      data: threads.map((t) => ({
        id: t.id,
        appointmentId: t.appointmentId,
        category: t.category,
        status: t.status,
        activeChannel: t.activeChannel,
        lastMessageAt: t.lastMessageAt ?? t.createdAt,
        createdAt: t.createdAt,
        resolvedAt: t.resolvedAt,
        supportTicketId: t.supportTicketId,
        organizationId: t.organizationId,
        messageCount: t._count.messages,
        lastMessage: t.messages[0]
          ? { sender: t.messages[0].sender, body: t.messages[0].body }
          : null,
        user: t.user,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      counts: Object.fromEntries(
        counts.map((c) => [c.status, c._count._all]),
      ) as Record<string, number>,
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: STAFF_THREADS_ROUTE, action: "list" },
    });
  }
}
