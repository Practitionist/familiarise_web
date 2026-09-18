import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { processOnboardingData } from "@/utils/onboarding-server";
import { resolveOnboardingEmailUpdate } from "@/utils/onboarding-shared";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, onboardingSubmitLimiter } from "@/lib/rate-limit";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await req.json();

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    if (!isPrivileged && session.user.id !== id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Same email-ownership rule as the server action twin: the session email
    // is verified at signup, so a self-service write must not move the row
    // onto a different address without re-verification.
    const bodyEmail =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).email
        : undefined;
    const emailCheck = resolveOnboardingEmailUpdate({
      bodyEmail,
      sessionEmail: session.user.email,
      isPrivileged,
    });
    if (!emailCheck.ok) {
      return NextResponse.json({ error: emailCheck.error }, { status: 403 });
    }

    // Same bucket as the server-action twin so both paths share one quota.
    const limited = await applyRateLimit(onboardingSubmitLimiter, session.user.id);
    if (limited) return limited;

    // Use central utility function directly
    const result = await processOnboardingData(id, body);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      message: "Onboarding information updated successfully",
      user: result.user,
    });
  } catch (error: unknown) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "form" } });
    console.error("Error updating onboarding information:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred while updating onboarding information",
      },
      { status: 500 },
    );
  }
}
