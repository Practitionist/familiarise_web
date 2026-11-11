import {
  PARTY_PROFILE_SELECT,
  PROFILE_OWNER_SELECT,
} from "@/lib/booking/list-selects";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { SubscriptionPlanSchema } from "@/schemas/plans";
import {
  curriculumCreateNested,
  faqReplaceNested,
} from "@/lib/api/plans/content";
import { findOrCreateTopics, transformTopicsToStrings } from "@/lib/topics";
import {
  activeClientsNotice,
  subscriptionPlanTotals,
} from "@/lib/booking/entitlement";
import { activeClientCount, freezeSoldTerms } from "@/lib/booking/sold-terms";
import { getMinTrialPriceInPaise } from "@/lib/trials/pricing-config";
import {
  assertSubscriptionPlanFloor,
  claimPlanTerms,
  editedTerms,
  planEditRefusal,
} from "@/lib/api/plans/plan-edit-guard";
import {
  archivedAtForArchive,
  parsePlanArchiveBody,
  PLAN_ORG_GOVERNED_RESPONSE,
  PLAN_ARCHIVE_RESPONSE_NOTE,
} from "@/lib/api/plans/archive";

import { getSession } from "@/lib/auth-server";
import {
  deleteUntouchedOffering,
  offeringDeleteRefusal,
  OfferingInUseError,
  UNTOUCHED_SUBSCRIPTION_PLAN,
} from "@/lib/booking/offering-delete";
import { planConsultantSelect } from "@/lib/api/plans/consultant-projection";
import { isHiddenDraft } from "@/lib/api/plans/draft-access";
/** A sold plan cannot switch between months and weeks. */
class PlanLengthUnitLockedError extends Error {
  constructor() {
    super(
      "Clients have bought this plan, so its length stays in the unit it was sold in. Publish a new plan to sell it in weeks.",
    );
    this.name = "PlanLengthUnitLockedError";
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  try {
    const { subscriptionPlanId } = await params;
    // #1527 Q4 — no booking rows: this GET is open to any caller, and neither
    // the editor nor checkout reads them.
    const subscriptionPlan = await prisma.subscriptionPlan.findUniqueOrThrow({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: { select: planConsultantSelect },
        topics: true,
        faqs: { orderBy: { order: "asc" } },
        subscriptionContents: {
          orderBy: { order: "asc" },
        },
      },
    });

    // #1527 Q4 — a draft is readable by its author only.
    if (await isHiddenDraft(subscriptionPlan)) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    // The editor asks for its live buyers so it can say a change spares them;
    // only the plan's author is told.
    const activeClients =
      request.nextUrl.searchParams.get("include") === "activeClients" &&
      (await getSession())?.user?.consultantProfileId ===
        subscriptionPlan.consultantProfileId
        ? await activeClientCount(prisma, subscriptionPlanId)
        : undefined;

    return NextResponse.json(
      {
        data: {
          ...transformTopicsToStrings(subscriptionPlan),
          ...(activeClients === undefined ? {} : { activeClients }),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "plans" } },
    );
    console.error("Error fetching subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the subscription plan" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { subscriptionPlanId } = await params;

    // Verify ownership - user must own this subscription plan
    const existingPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: { consultantProfile: PROFILE_OWNER_SELECT },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to update this subscription plan",
        },
        { status: 403 },
      );
    }

    const body = await request.json();

    // Validate input with Zod schema (partial for updates)
    const validationResult = SubscriptionPlanSchema.partial().safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;

    // Terms edits re-derive the plan's totals; sold subscriptions keep theirs.
    const termsChange =
      validatedData.sessionsPerWeek !== undefined ||
      validatedData.durationInMonths !== undefined ||
      validatedData.durationInWeeks !== undefined ||
      validatedData.sessionDurationInHours !== undefined;
    const durationInWeeks =
      validatedData.durationInWeeks === undefined
        ? existingPlan.durationInWeeks
        : validatedData.durationInWeeks;
    const unitSwitch =
      (existingPlan.durationInWeeks === null) !== (durationInWeeks === null);
    const derived = termsChange
      ? {
          durationInWeeks,
          ...subscriptionPlanTotals({
            sessionsPerWeek:
              validatedData.sessionsPerWeek ?? existingPlan.sessionsPerWeek,
            durationInMonths:
              validatedData.durationInMonths ?? existingPlan.durationInMonths,
            durationInWeeks,
            sessionDurationInHours:
              validatedData.sessionDurationInHours ??
              existingPlan.sessionDurationInHours,
          }),
        }
      : null;

    // Only a short pack whose edit changes the stored price or terms is held to the pack floor.
    const storedTerms = {
      price: existingPlan.price,
      sessionDurationInHours: existingPlan.sessionDurationInHours,
      totalSessions: existingPlan.totalSessions,
      durationInWeeks: existingPlan.durationInWeeks,
    };
    const { terms, changed } = editedTerms(storedTerms, {
      price:
        validatedData.price === undefined
          ? undefined
          : Math.round(validatedData.price),
      sessionDurationInHours: validatedData.sessionDurationInHours,
      totalSessions: derived?.totalSessions,
      durationInWeeks,
    });
    if (changed) {
      assertSubscriptionPlanFloor({
        pricePaise: terms.price,
        sessionDurationInHours: terms.sessionDurationInHours,
        totalSessions: terms.totalSessions,
        durationInWeeks: terms.durationInWeeks,
      });
    }

    // Floor check on the effective post-update trial price. Untouched
    // plans are never retro-policed — only edits that set a price or
    // newly enable the trial run against the platform floor.
    const effectiveTrialEnabled =
      validatedData.trialEnabled ?? existingPlan.trialEnabled;
    if (
      effectiveTrialEnabled &&
      (validatedData.trialPriceInPaise !== undefined ||
        validatedData.trialEnabled === true)
    ) {
      const effectivePrice =
        validatedData.trialPriceInPaise ?? existingPlan.trialPriceInPaise;
      const floor = await getMinTrialPriceInPaise();
      if (effectivePrice < floor) {
        return NextResponse.json(
          { error: `Trial price must be at least ₹${floor / 100}` },
          { status: 400 },
        );
      }
    }

    // Handle topics if provided
    let topicsUpdate = {};
    if (validatedData.topics !== undefined) {
      const topicIds = await findOrCreateTopics(validatedData.topics);
      topicsUpdate = {
        topics: { set: topicIds.map((id) => ({ id })) },
      };
    }

    // Handle subscription contents (roadmap) if provided
    const subscriptionContents = body.subscriptionContents as
      | Array<{
          id?: string;
          title: string;
          description: string;
          contentType?: string;
          contentUrl?: string;
          order: number;
          hoursAllotted?: number;
          sectionLabel?: string | null;
          outcomes?: string[];
        }>
      | undefined;

    // Use transaction to ensure atomicity when updating subscription contents
    // This prevents data loss if the update fails after deleting old contents
    const subscriptionPlan = await prisma.$transaction(async (tx) => {
      // Save only against the price and terms this edit was validated on.
      await claimPlanTerms(
        tx.subscriptionPlan.updateMany({
          where: {
            id: subscriptionPlanId,
            ...storedTerms,
            sessionsPerWeek: existingPlan.sessionsPerWeek,
            durationInMonths: existingPlan.durationInMonths,
          },
          data: { price: terms.price },
        }),
      );
      // If subscriptionContents is provided, delete existing and create new ones
      if (subscriptionContents !== undefined) {
        await tx.subscriptionContent.deleteMany({
          where: { subscriptionPlanId },
        });
      }
      // A sold plan keeps the unit it was sold in; a new unit is a new plan.
      if (
        unitSwitch &&
        (await tx.subscription.count({ where: { subscriptionPlanId } })) > 0
      )
        throw new PlanLengthUnitLockedError();
      if (derived) await freezeSoldTerms(tx, subscriptionPlanId);

      return tx.subscriptionPlan.update({
        where: { id: subscriptionPlanId },
        data: {
          title: validatedData.title,
          description: validatedData.description,
          ...derived,
          price:
            validatedData.price !== undefined
              ? Math.round(validatedData.price)
              : undefined,
          priceCurrency: validatedData.priceCurrency,
          sessionsPerWeek: validatedData.sessionsPerWeek,
          sessionDurationInHours: validatedData.sessionDurationInHours,
          emailSupport: validatedData.emailSupport,
          language: validatedData.language,
          level: validatedData.level,
          prerequisites: validatedData.prerequisites,
          materialProvided: validatedData.materialProvided,
          learningOutcomes: validatedData.learningOutcomes,
          subtitle: validatedData.subtitle,
          targetAudience: validatedData.targetAudience,
          whatsIncluded: validatedData.whatsIncluded,
          faqs: faqReplaceNested(validatedData.faqs),
          recordingEnabled: validatedData.recordingEnabled,
          // #1527 Q4 — absent means PUBLISHED on create and unchanged on update.
          status: validatedData.status,
          trialEnabled: validatedData.trialEnabled,
          trialDurationMinutes: validatedData.trialDurationMinutes,
          trialPriceInPaise: validatedData.trialPriceInPaise,
          ...topicsUpdate,
          subscriptionContents:
            subscriptionContents !== undefined
              ? {
                  create: curriculumCreateNested(
                    subscriptionContents.map((c) => ({
                      ...c,
                      hoursAllotted: c.hoursAllotted ?? 1.0,
                    })),
                  ).create,
                }
              : undefined,
        },
        include: {
          consultantProfile: PARTY_PROFILE_SELECT,
          subscriptions: {
            include: {
              requestedBy: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                      image: true,
                    },
                  },
                },
              },
            },
          },
          topics: true,
          faqs: { orderBy: { order: "asc" } },
          subscriptionContents: {
            orderBy: { order: "asc" },
          },
        },
      });
    });

    // Sold subscriptions keep their frozen terms; say how many the edit spared.
    const activeClients = await activeClientCount(prisma, subscriptionPlanId);
    return NextResponse.json(
      {
        data: transformTopicsToStrings(subscriptionPlan),
        activeClients,
        notice: activeClientsNotice(activeClients),
      },
      { status: 200 },
    );
  } catch (error) {
    const refusal = planEditRefusal(error);
    if (refusal) return refusal;
    if (error instanceof PlanLengthUnitLockedError) {
      return NextResponse.json(
        { error: error.message, code: "PLAN_LENGTH_UNIT_LOCKED" },
        { status: 409 },
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "plans" } },
    );
    console.error("Error updating subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the subscription plan" },
      { status: 500 },
    );
  }
}

/**
 * Sole-owner archive/restore (#1494) — a consultant stops selling a
 * subscription offering without the org-catalog bulk-archive path.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { subscriptionPlanId } = await params;

    const parsedBody = await parsePlanArchiveBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.error, details: parsedBody.details },
        { status: 400 },
      );
    }
    const { archived } = parsedBody;

    const existingPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: { consultantProfile: PROFILE_OWNER_SELECT },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to update this subscription plan",
        },
        { status: 403 },
      );
    }

    if (existingPlan.organizationId) {
      return NextResponse.json(PLAN_ORG_GOVERNED_RESPONSE, { status: 403 });
    }

    const subscriptionPlan = await prisma.subscriptionPlan.update({
      where: { id: subscriptionPlanId },
      data: {
        archivedAt: archived
          ? archivedAtForArchive(existingPlan.archivedAt)
          : null,
      },
    });

    return NextResponse.json(
      {
        data: {
          id: subscriptionPlan.id,
          archivedAt: subscriptionPlan.archivedAt,
        },
        message: PLAN_ARCHIVE_RESPONSE_NOTE,
      },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "plans" } },
    );
    console.error("Error archiving subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the subscription plan" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { subscriptionPlanId } = await params;

    // Verify ownership - user must own this subscription plan
    const existingPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: { consultantProfile: PROFILE_OWNER_SELECT },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        {
          error: "You do not have permission to delete this subscription plan",
        },
        { status: 403 },
      );
    }

    // #1846 CT-02 — the no-history guard rides the DELETE's WHERE inside one
    // Serializable transaction under the plan's checkout lock
    // (lib/booking/offering-delete.ts); a trial counts as history too.
    const ownedPlan = {
      id: subscriptionPlanId,
      consultantProfile: { userId: session.user.id },
    };
    const subscriptionPlan = await deleteUntouchedOffering(
      "SUBSCRIPTION",
      subscriptionPlanId,
      async (tx) => {
        const plan = await tx.subscriptionPlan.findFirst({
          where: ownedPlan,
          include: {
            consultantProfile: PARTY_PROFILE_SELECT,
            topics: true,
          },
        });
        if (!plan) return null;
        const { count } = await tx.subscriptionPlan.deleteMany({
          where: { ...ownedPlan, ...UNTOUCHED_SUBSCRIPTION_PLAN },
        });
        if (count === 0) throw new OfferingInUseError("SUBSCRIPTION");
        return plan;
      },
    );
    if (!subscriptionPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { data: transformTopicsToStrings(subscriptionPlan) },
      { status: 200 },
    );
  } catch (error) {
    const refusal = offeringDeleteRefusal(error);
    if (refusal) {
      return NextResponse.json(refusal.body, { status: refusal.status });
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "plans" } },
    );
    console.error("Error deleting subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the subscription plan" },
      { status: 500 },
    );
  }
}
