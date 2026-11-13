import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { readOwnStrikes } from "@/lib/booking/expert-reliability";
import prisma from "@/lib/prisma";

/** GET — the expert's own reliability strikes. Owner only: strikes never reach a public page. */
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
      select: { userId: true },
    });
    if (!profile || profile.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      { data: await readOwnStrikes(id) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { subsystem: "consultants" } });
    return NextResponse.json(
      { error: "Couldn't load your reliability record" },
      { status: 500 },
    );
  }
}
