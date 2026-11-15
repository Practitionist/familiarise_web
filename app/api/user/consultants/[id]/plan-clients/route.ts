import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { activePlanClientIds } from "@/lib/booking/plan-demand";
import prisma from "@/lib/prisma";
import type { PlanClientsRead } from "@/schemas/plan-clients";

/**
 * GET — how many distinct buyers hold one of the expert's 1:1 plans right now,
 * and the expert's own limit. Owner only: both numbers are private.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const profile = await prisma.consultantProfile.findUnique({
      where: { id },
      select: { userId: true, maxActivePlanClients: true },
    });
    if (!profile || profile.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const clients = await activePlanClientIds(prisma, id);
    const data: PlanClientsRead = {
      activePlanClients: clients.length,
      maxActivePlanClients: profile.maxActivePlanClients,
    };
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { subsystem: "consultants" } });
    return NextResponse.json(
      { error: "Couldn't count your plan clients" },
      { status: 500 },
    );
  }
}
