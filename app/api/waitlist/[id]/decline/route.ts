import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { withdrawBackupInterest } from "@/lib/booking/backup-interest";

const paramsSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid waitlist entry id" },
        { status: 400 },
      );
    }

    const { id } = parsedParams.data;
    const userId = session.user.id;

    const backupResult = await withdrawBackupInterest(userId, id);
    if (backupResult.count > 0) {
      return NextResponse.json({
        data: {
          id,
          status: "WITHDRAWN",
          declined: true,
        },
      });
    }

    const entry = await prisma.windowBackupInterest.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    });
    if (!entry) {
      return NextResponse.json(
        { error: "Waitlist entry not found" },
        { status: 404 },
      );
    }
    if (entry.userId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      { error: `Cannot decline a waitlist entry with status ${entry.status}` },
      { status: 409 },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "waitlist" } },
    );
    console.error("[waitlist/decline]", error);
    return NextResponse.json(
      { error: "Could not decline spot right now. Please try again." },
      { status: 500 },
    );
  }
}
