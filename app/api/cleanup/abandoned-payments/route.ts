import { NextRequest, NextResponse } from "next/server";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import {
  cleanupAbandonedPayments,
  cleanupExpiredApprovalPendingPayments,
  disconnectDatabase,
} from "@/scripts/payments/cleanup-abandoned-payments";

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

    // Run both cleanup tasks
    const paymentResult = await cleanupAbandonedPayments();
    const consultationResult = await cleanupExpiredApprovalPendingPayments();
    await disconnectDatabase();

    return NextResponse.json({
      paymentCleanup: paymentResult,
      consultationCleanup: consultationResult,
      overallSuccess: paymentResult.success && consultationResult.success,
    });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Cleanup API route failed:", error);
    return NextResponse.json(
      {
        error: "Cleanup job failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
