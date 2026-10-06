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

    const [backupResult, waitlistResult] = await Promise.all([
      withdrawBackupInterest(userId, id),
      prisma.waitlist.updateMany({
        where: {
          id,
          userId,
          status: { in: ["PENDING", "SUBSCRIBED"] },
        },
        data: {
          status: "UNSUBSCRIBED",
          unsubscribedAt: new Date(),
        },
      }),
    ]);

    return NextResponse.json({
      data: {
        id,
        declined: backupResult.count > 0 || waitlistResult.count > 0,
      },
    });
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
