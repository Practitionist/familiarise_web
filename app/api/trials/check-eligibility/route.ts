import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { eligibilityLimiter, applyRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * GET /api/trials/check-eligibility
 * Check if a consultee is eligible to request a trial for a specific consultant
 *
 * Query params:
 * - consulteeProfileId: The consultee's profile ID
 * - consultantProfileId: The consultant's profile ID
 * - subscriptionPlanId: Optional - check if specific plan has trial enabled
 */
export async function GET(request: NextRequest) {
  // Rate limit: 20 eligibility checks per minute per IP
  const rl = await applyRateLimit(eligibilityLimiter, getClientIp(request));
  if (rl) return rl;

  const { searchParams } = new URL(request.url);
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const consultantProfileId = searchParams.get("consultantProfileId");
  const subscriptionPlanId = searchParams.get("subscriptionPlanId");

  if (!consulteeProfileId || !consultantProfileId) {
    return NextResponse.json(
      { error: "consulteeProfileId and consultantProfileId are required" },
      { status: 400 },
    );
  }

  try {
    // Check if a trial already exists for this consultee-consultant pair
    const existingTrial = await prisma.trialSession.findUnique({
      where: {
        consulteeProfileId_consultantProfileId: {
          consulteeProfileId,
          consultantProfileId,
        },
      },
      select: {
        id: true,
        status: true,
        subscriptionPlanId: true,
        requestedAt: true,
      },
    });

    // If specific plan is requested, check if it has trial enabled
    let planTrialEnabled = true;
    let planTrialDuration = 30;

    if (subscriptionPlanId) {
      const plan = await prisma.subscriptionPlan.findUnique({
        where: { id: subscriptionPlanId },
        select: {
          freeTrialEnabled: true,
          freeTrialDurationMinutes: true,
          title: true,
        },
      });

      if (!plan) {
        return NextResponse.json(
          { error: "Subscription plan not found" },
          { status: 404 },
        );
      }

      planTrialEnabled = plan.freeTrialEnabled;
      planTrialDuration = plan.freeTrialDurationMinutes;
    }

    // Get all plans with trial enabled for this consultant
    const plansWithTrialEnabled = await prisma.subscriptionPlan.findMany({
      where: {
        consultantProfileId,
        freeTrialEnabled: true,
      },
      select: {
        id: true,
        title: true,
        freeTrialDurationMinutes: true,
      },
    });

    const isEligible = !existingTrial && planTrialEnabled;

    return NextResponse.json({
      data: {
        isEligible,
        hasExistingTrial: !!existingTrial,
        existingTrial: existingTrial
          ? {
              id: existingTrial.id,
              status: existingTrial.status,
              subscriptionPlanId: existingTrial.subscriptionPlanId,
              requestedAt: existingTrial.requestedAt,
            }
          : null,
        planTrialEnabled,
        planTrialDuration,
        plansWithTrialEnabled,
        reason: !isEligible
          ? existingTrial
            ? "You have already requested or completed a trial with this consultant"
            : "This plan does not offer free trials"
          : null,
      },
    });
  } catch (error) {
    console.error("Error checking trial eligibility:", error);
    return NextResponse.json(
      { error: "An error occurred while checking trial eligibility" },
      { status: 500 },
    );
  }
}
