import { NextRequest, NextResponse } from "next/server";
import {
  reconcileOrphanedSessions,
  disconnectDatabase,
} from "@/jobs/meetings/reconcile-orphaned-sessions";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message:
            "Please provide a valid authorization header with the CRON_SECRET",
        },
        { status: 401 },
      );
    }

    const result = await reconcileOrphanedSessions();
    await disconnectDatabase();

    return NextResponse.json(result);
  } catch (error) {
    console.error("Reconcile sessions API route failed:", error);
    return NextResponse.json(
      {
        error: "Reconciliation job failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
