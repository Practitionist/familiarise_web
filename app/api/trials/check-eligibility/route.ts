import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { blockingTrialWhere } from "@/lib/trials/eligibility";
import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import {
  eventPlanDiscoverableWhere,
  oneOnOnePlanDiscoverableWhere,
  planSaleRefusal,
} from "@/lib/api/plans/visibility";
import { publicExpertProfileWhere } from "@/lib/profiles/public-profile";

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
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

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

  // IDOR protection: non-privileged users can only check their own eligibility
  if (!isPrivileged(session.user.role)) {
    if (
      consulteeProfileId !== session.user.consulteeProfileId &&
      consultantProfileId !== session.user.consultantProfileId
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Only the expert sees their own hidden plans; everyone else gets what the public lists show.
  const isOwner = consultantProfileId === session.user.consultantProfileId;
  const listed = isOwner
    ? {}
    : {
        ...eventPlanDiscoverableWhere(),
        consultantProfile: publicExpertProfileWhere,
      };

  try {
    // Only the pair's live or delivered trial blocks; ended ones stay as history.
    const blockingTrial = await prisma.trial.findFirst({
      where: blockingTrialWhere({ consulteeProfileId, consultantProfileId }),
      orderBy: { requestedAt: "desc" },
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
    let planTrialPriceInPaise = 0;
    // #1527 Q4 — a DRAFT plan takes no new trial requests.
    let planNotPublished = false;

    if (subscriptionPlanId) {
      const plan = await prisma.subscriptionPlan.findFirst({
        where: { id: subscriptionPlanId, consultantProfileId, ...listed },
        select: {
          trialEnabled: true,
          trialDurationMinutes: true,
          trialPriceInPaise: true,
          title: true,
          status: true,
        },
      });

      if (!plan) {
        return NextResponse.json(
          { error: "Subscription plan not found" },
          { status: 404 },
        );
      }

      planTrialEnabled = plan.trialEnabled;
      planTrialDuration = plan.trialDurationMinutes;
      planTrialPriceInPaise = plan.trialPriceInPaise;
      planNotPublished = planSaleRefusal(plan) !== null;
    }

    // Get all plans with trial enabled for this consultant
    const plansWithTrialEnabled = await prisma.subscriptionPlan.findMany({
      where: {
        consultantProfileId,
        trialEnabled: true,
        ...oneOnOnePlanDiscoverableWhere(),
        ...(isOwner ? {} : { consultantProfile: publicExpertProfileWhere }),
      },
      select: {
        id: true,
        title: true,
        trialDurationMinutes: true,
        trialPriceInPaise: true,
      },
    });

    const isEligible = !blockingTrial && planTrialEnabled && !planNotPublished;
    let reason: string | null = null;
    if (blockingTrial) {
      reason =
        "You have already requested or completed a trial with this consultant";
    } else if (planNotPublished) {
      reason = "This plan isn't available to book right now.";
    } else if (!planTrialEnabled) {
      reason = "This plan does not offer trials";
    }

    return NextResponse.json({
      data: {
        isEligible,
        hasExistingTrial: !!blockingTrial,
        existingTrial: blockingTrial
          ? {
              id: blockingTrial.id,
              status: blockingTrial.status,
              subscriptionPlanId: blockingTrial.subscriptionPlanId,
              requestedAt: blockingTrial.requestedAt,
            }
          : null,
        planTrialEnabled,
        planTrialDuration,
        planTrialPriceInPaise,
        plansWithTrialEnabled,
        reason,
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "trials" } },
    );
    console.error("Error checking trial eligibility:", error);
    return NextResponse.json(
      { error: "An error occurred while checking trial eligibility" },
      { status: 500 },
    );
  }
}
