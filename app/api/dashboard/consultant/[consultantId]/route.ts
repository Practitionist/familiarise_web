import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { getConsultantDashboard } from "@/lib/data/consultant-dashboard";

// =============================================================================
// Route Handler
// =============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  // Note: request parameter kept for Next.js API route signature compatibility
  void request;

  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const resolvedParams = await params;
    const { consultantId: consultantProfileId } = resolvedParams;

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    // Capability, not UserRole (#org-appts): the id match IS the ownership
    // proof; the `role === "CONSULTANT"` conjunct wrongly excluded an org EXPERT
    // who owns this profile.
    const ownsProfile =
      session.user.consultantProfileId === consultantProfileId;

    if (!isPrivileged && !ownsProfile) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    // #890 — shared read; same fn the consultant home server page calls so
    // SSR hydration matches.
    const data = await getConsultantDashboard(consultantProfileId);

    // Return consolidated response
    return NextResponse.json(
      {
        success: true,
        data,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    console.error("Error fetching dashboard data:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch dashboard data",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
