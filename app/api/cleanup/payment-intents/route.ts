import { NextRequest, NextResponse } from "next/server";
import { PaymentCleanupService } from "@/jobs/payment-cleanup";
import { ErrorLogger, handleApiError, generateRequestId } from "@/utils/errorHandling";

// Manual cleanup endpoint (can be called by cron jobs or admin interface)
export async function POST(req: NextRequest) {
  const requestId = generateRequestId();

  try {
    // Basic authentication check (you might want to add proper API key authentication)
    const authHeader = req.headers.get("authorization");
    const expectedAuth = process.env.CLEANUP_API_KEY;

    if (!expectedAuth) {
      ErrorLogger.warn("Cleanup API key not configured", { requestId });
      return NextResponse.json(
        { error: "Cleanup service not configured" },
        { status: 503 }
      );
    }

    if (!authHeader || authHeader !== `Bearer ${expectedAuth}`) {
      ErrorLogger.warn("Unauthorized cleanup attempt", {
        requestId,
        authHeader: authHeader ? "present" : "missing",
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
      });
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    ErrorLogger.info("Payment cleanup initiated via API", { requestId });

    // Run comprehensive cleanup
    const results = await PaymentCleanupService.runComprehensiveCleanup();

    ErrorLogger.info("Payment cleanup completed via API", {
      requestId,
      results,
    });

    return NextResponse.json({
      success: true,
      message: "Payment cleanup completed successfully",
      results,
      requestId,
    });
  } catch (error) {
    ErrorLogger.error("Payment cleanup API failed", error, { requestId });
    return handleApiError(error, requestId);
  }
}

// Get cleanup statistics
export async function GET(req: NextRequest) {
  const requestId = generateRequestId();

  try {
    // Basic authentication check
    const authHeader = req.headers.get("authorization");
    const expectedAuth = process.env.CLEANUP_API_KEY;

    if (!expectedAuth) {
      return NextResponse.json(
        { error: "Cleanup service not configured" },
        { status: 503 }
      );
    }

    if (!authHeader || authHeader !== `Bearer ${expectedAuth}`) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get current statistics about potentially problematic payments
    const stats = await PaymentCleanupService.getCleanupStatistics();

    return NextResponse.json({
      success: true,
      statistics: stats,
      requestId,
    });
  } catch (error) {
    ErrorLogger.error("Payment cleanup statistics API failed", error, { requestId });
    return handleApiError(error, requestId);
  }
}