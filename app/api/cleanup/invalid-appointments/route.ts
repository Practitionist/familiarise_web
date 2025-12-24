import { NextRequest, NextResponse } from "next/server";
import {
  runAllCleanupTasks,
  disconnectDatabase,
} from "@/scripts/cleanup-invalid-appointments";

export async function POST(req: NextRequest) {
  try {
    // Verify this is called by a cron job or authorized service
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

    // Run all cleanup tasks
    const result = await runAllCleanupTasks();
    await disconnectDatabase();

    return NextResponse.json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Invalid appointments cleanup API route failed:", error);
    return NextResponse.json(
      {
        error: "Cleanup job failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
