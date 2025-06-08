import { NextRequest, NextResponse } from "next/server";
import { cleanupAbandonedPayments } from "@/jobs/cleanup-abandoned-payments";

export async function POST(req: NextRequest) {
  try {
    // Verify this is called by a cron job or authorized service
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized", message: "Please provide a valid authorization header with the CRON_SECRET" }, { status: 401 });
    }

    // Use the centralized cleanup job
    const result = await cleanupAbandonedPayments();

    return NextResponse.json(result);

  } catch (error) {
    console.error("Cleanup API route failed:", error);
    return NextResponse.json(
      { 
        error: "Cleanup job failed", 
        details: error instanceof Error ? error.message : String(error) 
      }, 
      { status: 500 }
    );
  }
} 