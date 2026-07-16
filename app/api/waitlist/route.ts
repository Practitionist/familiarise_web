/**
 * Waitlist API Routes
 * POST: Join a waitlist
 * GET: Get user's waitlist entries
 */

import { NextRequest, NextResponse } from "next/server";
import { joinWaitlist, getUserWaitlistEntries } from "@/lib/waitlist";
import { sendWaitlistJoinedEmail } from "@/lib/waitlist/notifications";
import prisma from "@/lib/prisma";
import { waitlistLimiter, applyRateLimit } from "@/lib/rate-limit";
import { resolveOrgScope } from "@/lib/api/scope/parse";

import { getSession } from "@/lib/auth-server";
import { assertBodySize } from "@/lib/validation/limits";
import * as Sentry from "@sentry/nextjs";
/**
 * POST /api/waitlist - Join a waitlist
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Rate limit: 5 waitlist joins per hour per user
    const rl = await applyRateLimit(waitlistLimiter, session.user.id);
    if (rl) return rl;

    // #831 — cap request body before parsing
    const tooLarge = assertBodySize(request);
    if (tooLarge) return tooLarge;

    const body = await request.json();
    const { webinarId, classId, preferences } = body;

    if (!webinarId && !classId) {
      return NextResponse.json(
        { success: false, error: "Either webinarId or classId is required" },
        { status: 400 },
      );
    }

    // Join the waitlist
    const result = await joinWaitlist({
      userId: session.user.id,
      webinarId,
      classId,
      preferences,
    });

    if (!result.success) {
      // Friendly 409 for the already-on-waitlist conflict (incl. the concurrent
      // double-join race that P2002 catches); everything else is a 400.
      const status = result.code === "ALREADY_ON_WAITLIST" ? 409 : 400;
      return NextResponse.json(
        { success: false, error: result.message },
        { status },
      );
    }

    // Get event details for email
    let eventTitle = "Event";
    const eventType: "webinar" | "class" = webinarId ? "webinar" : "class";

    if (webinarId) {
      const webinar = await prisma.webinar.findUnique({
        where: { id: webinarId },
        include: { webinarPlan: true },
      });
      if (webinar) {
        eventTitle = webinar.webinarPlan.title;
      }
    } else if (classId) {
      const classInstance = await prisma.class.findUnique({
        where: { id: classId },
        include: { classPlan: true },
      });
      if (classInstance) {
        eventTitle = classInstance.classPlan.title;
      }
    }

    // Send confirmation email
    if (session.user.email) {
      await sendWaitlistJoinedEmail({
        email: session.user.email,
        name: session.user.name || "Valued User",
        eventTitle,
        eventType,
        position: result.position!,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        id: result.waitlistId,
        position: result.position,
        message: result.message,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "waitlist" } });
    console.error("Error joining waitlist:", error);
    return NextResponse.json(
      { success: false, error: "Failed to join waitlist" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/waitlist - Get user's waitlist entries (org-scope-aware)
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // #674 org-scope filter — Waitlist.organizationId is populated by
    // the backfill so the consultant's "Waitlist" tab can split per
    // tenant context without leaking cross-org entries.
    const { searchParams } = new URL(request.url);
    const callerMemberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true, status: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        {
          success: false,
          error: scopeResolution.message,
          code: scopeResolution.code,
        },
        { status: scopeResolution.status },
      );
    }
    const orgFilter =
      scopeResolution.scope.kind === "personal"
        ? { organizationId: null }
        : scopeResolution.scope.kind === "org"
          ? { organizationId: scopeResolution.scope.orgId }
          : {};

    const entries = await getUserWaitlistEntries(session.user.id, orgFilter);

    return NextResponse.json({
      success: true,
      data: entries,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "waitlist" } });
    console.error("Error fetching waitlist entries:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch waitlist entries" },
      { status: 500 },
    );
  }
}
