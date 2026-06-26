/**
 * Waitlist Response API
 * POST: Respond to a waitlist notification (ACCEPT/DECLINE/SKIP)
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { handleWaitlistResponse } from "@/lib/waitlist";

import { getSession } from "@/lib/auth-server";
interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/waitlist/[id]/respond - Respond to waitlist notification
 *
 * Request body:
 * { action: "ACCEPT" | "DECLINE" | "SKIP" }
 *
 * Or via query param for email links:
 * GET /api/waitlist/[id]/respond?action=ACCEPT
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { id } = await params;
    const body = await request.json();
    const { action } = body;

    if (!action || !["ACCEPT", "DECLINE", "SKIP"].includes(action)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid action. Must be ACCEPT, DECLINE, or SKIP",
        },
        { status: 400 },
      );
    }

    const result = await handleWaitlistResponse({
      waitlistId: id,
      userId: session.user.id,
      action,
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.message },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      redirectUrl: result.redirectUrl,
      message: result.message,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "waitlist" } });
    console.error("Error responding to waitlist:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process response" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/waitlist/[id]/respond?action=ACCEPT
 * Handles email link clicks
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action")?.toUpperCase();

    // If not logged in, redirect to login with callback
    if (!session?.user?.id) {
      const loginUrl = `/auth/signin?callbackUrl=${encodeURIComponent(request.url)}`;
      return NextResponse.redirect(new URL(loginUrl, request.url));
    }

    if (!action || !["ACCEPT", "DECLINE", "SKIP"].includes(action)) {
      return NextResponse.redirect(
        new URL(`/dashboard?error=invalid_action`, request.url),
      );
    }

    const result = await handleWaitlistResponse({
      waitlistId: id,
      userId: session.user.id,
      action: action as "ACCEPT" | "DECLINE" | "SKIP",
    });

    if (!result.success) {
      // Redirect to dashboard with error message
      return NextResponse.redirect(
        new URL(
          `/dashboard?error=${encodeURIComponent(result.message)}`,
          request.url,
        ),
      );
    }

    // Redirect based on action
    if (result.redirectUrl) {
      return NextResponse.redirect(new URL(result.redirectUrl, request.url));
    }

    // Default redirect to dashboard with success message
    return NextResponse.redirect(
      new URL(
        `/dashboard?message=${encodeURIComponent(result.message)}`,
        request.url,
      ),
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "waitlist" } });
    console.error("Error responding to waitlist via GET:", error);
    return NextResponse.redirect(
      new URL("/dashboard?error=processing_failed", request.url),
    );
  }
}
