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

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  SupportThreadStatus,
  SupportChannel,
  SupportThreadCategory,
  Prisma,
} from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as SupportThreadStatus | null;
    const channel = searchParams.get("channel") as SupportChannel | null;
    const category = searchParams.get("category") as SupportThreadCategory | null;
    const search = searchParams.get("search");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "20")));
    const offset = (page - 1) * limit;

    const where: Prisma.AppointmentSupportThreadWhereInput = {};
    if (status) where.status = status;
    if (channel) where.activeChannel = channel;
    if (category) where.category = category;
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
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      { error: "Failed to load support threads" },
      { status: 500 },
    );
  }
}
