import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { readExpertDemand } from "@/lib/data/expert-demand";
import prisma from "@/lib/prisma";
import { expertDemandSchema } from "@/schemas/expert-demand";

/**
 * GET — the expert's own load for the demand banner: open requests against the
 * cap, the nearest expiry, unplaced paid plans, how booked the next 14 days
 * are and how many learners wait. Owner only; never public.
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
      select: {
        id: true,
        userId: true,
        acceptingRequests: true,
        bookingMode: true,
        maxOpenRequests: true,
      },
    });
    if (!profile || profile.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const data = expertDemandSchema.parse(await readExpertDemand(profile));
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { subsystem: "consultants" } });
    return NextResponse.json(
      { error: "Couldn't read your booking load" },
      { status: 500 },
    );
  }
}
