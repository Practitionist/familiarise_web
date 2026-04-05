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

import { getSession } from "@/lib/auth-server";
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
      return NextResponse.json(
        { success: false, error: result.message },
        { status: 400 },
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
    console.error("Error joining waitlist:", error);
    return NextResponse.json(
      { success: false, error: "Failed to join waitlist" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/waitlist - Get user's waitlist entries
 */
export async function GET() {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const entries = await getUserWaitlistEntries(session.user.id);

    return NextResponse.json({
      success: true,
      data: entries,
    });
  } catch (error) {
    console.error("Error fetching waitlist entries:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch waitlist entries" },
      { status: 500 },
    );
  }
}
