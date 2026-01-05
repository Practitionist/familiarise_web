import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runAllCleanupTasks } from "@/scripts/appointments/cleanup-invalid-appointments";

export async function POST(req: NextRequest) {
  try {
    // Fail safely if CRON_SECRET is not configured
    if (!process.env.CRON_SECRET) {
      console.error("CRON_SECRET environment variable not set");
      return NextResponse.json(
        { error: "Internal Server Error", message: "Server misconfigured" },
        { status: 500 },
      );
    }

    // Verify this is called by a cron job or authorized service
    // Use timing-safe comparison to prevent timing attacks
    const authHeader = req.headers.get("authorization");
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;

    const providedAuthBuffer = Buffer.from(authHeader || "");
    const expectedAuthBuffer = Buffer.from(expectedAuth);

    if (
      providedAuthBuffer.length !== expectedAuthBuffer.length ||
      !timingSafeEqual(providedAuthBuffer, expectedAuthBuffer)
    ) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message:
            "Please provide a valid authorization header with the CRON_SECRET",
        },
        { status: 401 },
      );
    }

    // Run all cleanup tasks (handles its own database disconnection)
    const result = await runAllCleanupTasks();

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
