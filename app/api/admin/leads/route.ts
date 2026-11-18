/**
 * GET /api/admin/leads
 *
 * Enterprise sales-pipeline list, gated on `leads.manage`: an optional status
 * filter and newest-first cursor pagination.
 */

import { NextResponse, type NextRequest } from "next/server";
import { LeadStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { z } from "zod";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { reportSentryError } from "@/lib/observability/report";

const PAGE_SIZE = 50;
const statusFilter = z.nativeEnum(LeadStatus).nullable();

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const auth = await requireBackofficeSurface("leads.manage");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(request.url);
    const rawStatus = searchParams.get("status");
    const cursor = searchParams.get("cursor");

    const parsedStatus = statusFilter.safeParse(rawStatus || null);
    if (!parsedStatus.success) {
      return NextResponse.json(
        { error: `Unknown lead status "${rawStatus}"` },
        { status: 400 },
      );
    }
    const status = parsedStatus.data;

    const leads = await prisma.lead.findMany({
      where: status ? { status } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sourceCategory: true,
        companyName: true,
        contactName: true,
        contactEmail: true,
        phone: true,
        subject: true,
        message: true,
        status: true,
        createdAt: true,
      },
    });

    const nextCursor =
      leads.length === PAGE_SIZE ? leads[leads.length - 1].id : null;

    return NextResponse.json({ leads, nextCursor });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "admin",
      op: "admin.leads.list",
      expected: false,
    });
    return NextResponse.json(
      { error: "Failed to load leads" },
      { status: 500 },
    );
  }
}
