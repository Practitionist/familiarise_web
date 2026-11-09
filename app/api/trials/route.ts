import prisma from "@/lib/prisma";
import { blocksNewTrialRequest } from "@/lib/trials/eligibility";
import { PaymentGateway, Prisma, TrialStatus } from "@prisma/client";
import { createApprovalPaymentIntent } from "@/lib/payments/operations/approval-payment";
import { persistTrialPayLink } from "@/lib/trials/pay-link";
import {
  bookTrialInTx,
  lockTrialPick,
  TrialTimeRefusedError,
} from "@/lib/trials/book-trial";
import {
  stageTrialScheduledNotices,
  type StagedScheduleNotices,
} from "@/lib/trials/schedule-notices";
import { TRIAL_WINDOW_REFUSAL_COPY } from "@/lib/trials/slot-check";
import { reportSentryError } from "@/lib/observability/report";
import { NextRequest, NextResponse } from "next/server";
import { prepareTrialScheduledEmail } from "@/lib/email/senders/booking";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { CreateTrialSchema } from "@/schemas/trials";
import { requireApiAuth } from "@/lib/auth-helpers";
import { trialRequestLimiter, applyRateLimit } from "@/lib/rate-limit";
import {
  resolveOrgScope,
  scopeToPlanHostWhere,
  scopeToWhereOrgId,
} from "@/lib/api/scope/parse";
import { isExclusionViolation, isUniqueViolation } from "@/lib/db/pg-errors";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { planSaleRefusal } from "@/lib/api/plans/visibility";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { assertRequestLeadFits } from "@/lib/booking/lead-time";
import { assertWindowMatchesPlanDuration } from "@/lib/booking/slot-validation";
import { getAppUrl } from "@/lib/url";
import { goHref } from "@/lib/dashboard/go";
import { assertNotSelfBooking } from "@/lib/booking/self-booking";
import { capacityRefusal } from "@/lib/booking/request-caps";
import { apiError } from "@/lib/errors/api-error";
import { isRefusal, Refusal } from "@/lib/errors/refusal";
import {
  BookingLockUnavailableError,
  lockRequestCap,
  RequestCapBusyError,
  unlockRequestCap,
} from "@/utils/appointmentlock";
import { SlotLockError } from "@/utils/errors/SlotLockError";

/**
 * GET /api/trials
 * List trial sessions with optional filters
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const subscriptionPlanId = searchParams.get("subscriptionPlanId");
  const status = searchParams.get("status") as TrialStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "requestedAt";
  const sortOrder = searchParams.get("sortOrder") || "desc";

  try {
    // #1583 D-P0-02 — fresh, ban-aware read; 401 / 403 / 503 shapes are the helper's.
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";

    // #org-appts — profile ids are carried independently of the singular
    // platform role, so a dual-profile user (e.g. a host EXPERT whose
    // marketplace role is CONSULTEE) must see a trial whether they are its
    // consultee OR its delivering consultant. Trials stay B2C: this is a pure
    // ownership union, never org-scoped. When neither side is requested via an
    // explicit `?consultant/consulteeProfileId=`, we fall back to the union of
    // whichever profiles the caller holds (built below as an OR).
    let applyOwnershipOr = false;
    if (!isPrivileged) {
      if (
        !session.user.consultantProfileId &&
        !session.user.consulteeProfileId
      ) {
        return NextResponse.json(
          {
            error:
              "No consultant or consultee profile configured. Please complete onboarding.",
          },
          { status: 422 },
        );
      }
      // Explicit profile-id filters stay locked to the caller's own ids.
      if (
        consultantProfileId &&
        consultantProfileId !== session.user.consultantProfileId
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (
        consulteeProfileId &&
        consulteeProfileId !== session.user.consulteeProfileId
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      // No explicit side requested → union both identities the caller holds.
      applyOwnershipOr = !consultantProfileId && !consulteeProfileId;
    }

    // #674 org-scope filter. Trial.organizationId is populated by
    // the backfill — keeps Acme-context views from leaking Zeta trial
    // bookings into the consultant's "Trials" tab.
    const callerMemberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: {
        organizationId: true,
        status: true,
        role: true,
        organization: { select: { status: true } },
      },
    });
    const scopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMemberships,
      userRole: session.user.role,
      userId: session.user.id,
      // Non-admin callers are already locked to their own
      // consultant/consulteeProfileId (lines 50-73), so `?orgScope=all`
      // means "all of MY trials" — safe for any role.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }

    // The delivering side splits on the subscription plan's host org, like
    // every request; the learner side on the trial's own org tag.
    const scope = scopeResolution.scope;
    const delivered = (cp: string): Prisma.TrialWhereInput => ({
      consultantProfileId: cp,
      subscriptionPlan: { ...scopeToPlanHostWhere(scope) },
    });
    const booked = (ce: string): Prisma.TrialWhereInput => ({
      consulteeProfileId: ce,
      ...scopeToWhereOrgId(scope),
    });
    const whereClause: Prisma.TrialWhereInput = {};

    if (applyOwnershipOr) {
      // #org-appts — dual-identity union; AND-nested so it composes with the
      // search OR below without clobbering it.
      const ownershipArms: Prisma.TrialWhereInput[] = [];
      if (session.user.consultantProfileId) {
        ownershipArms.push(delivered(session.user.consultantProfileId));
      }
      if (session.user.consulteeProfileId) {
        ownershipArms.push(booked(session.user.consulteeProfileId));
      }
      whereClause.AND = [{ OR: ownershipArms }];
    } else {
      const sides: Prisma.TrialWhereInput[] = [
        ...(consultantProfileId ? [delivered(consultantProfileId)] : []),
        ...(consulteeProfileId ? [booked(consulteeProfileId)] : []),
      ];
      whereClause.AND =
        sides.length > 0 ? sides : [{ ...scopeToWhereOrgId(scope) }];
    }

    if (subscriptionPlanId) {
      whereClause.subscriptionPlanId = subscriptionPlanId;
    }

    if (status) {
      whereClause.status = status;
    }

    if (search) {
      whereClause.OR = [
        {
          consulteeProfile: {
            user: { name: { contains: search, mode: "insensitive" } },
          },
        },
        {
          consulteeProfile: {
            user: { email: { contains: search, mode: "insensitive" } },
          },
        },
      ];
    }

    // Dynamic orderBy mapping
    const orderByMap: Record<string, Prisma.TrialOrderByWithRelationInput> = {
      requestedAt: { requestedAt: sortOrder as "asc" | "desc" },
      status: { status: sortOrder as "asc" | "desc" },
      name: {
        consulteeProfile: { user: { name: sortOrder as "asc" | "desc" } },
      },
      plan: { subscriptionPlan: { title: sortOrder as "asc" | "desc" } },
    };
    const orderBy = orderByMap[sortBy] || orderByMap.requestedAt;

    const [trials, total] = await Promise.all([
      prisma.trial.findMany({
        where: whereClause,
        include: {
          consulteeProfile: {
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
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
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
          subscriptionPlan: true,
          appointment: {
            include: {
              occurrences: true,
            },
          },
          convertedToSubscription: true,
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.trial.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: trials,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching trial sessions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial sessions" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/trials
 * Request a new trial session
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const body = await request.json();
    const result = CreateTrialSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const {
      consulteeProfileId,
      consultantProfileId,
      subscriptionPlanId,
      notes,
      organizationId,
      slot,
    } = result.data;

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    // Any role may take a trial as a learner, with their own learner profile.
    if (
      !isPrivileged &&
      session.user.consulteeProfileId !== consulteeProfileId
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Rate limit: 3 trial requests per 24 hours per creator. #831 — applied
    // uniformly: a privileged session can still flood consultant inboxes,
    // so role no longer bypasses the limiter.
    const rl = await applyRateLimit(trialRequestLimiter, session.user.id);
    if (rl) return rl;

    // #1527 review — the plan lookup + refusal checks used to run AFTER the
    // freed-trial deleteMany below, so a request against a DRAFT plan (409)
    // still consumed the consultee's freed trial slot. Verify the plan first.
    const subscriptionPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: {
          select: {
            id: true,
            acceptingRequests: true,
            maxOpenRequests: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!subscriptionPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    if (subscriptionPlan.consultantProfileId !== consultantProfileId) {
      return NextResponse.json(
        { error: "Subscription plan does not belong to this consultant" },
        { status: 400 },
      );
    }

    try {
      assertNotSelfBooking(session.user.consultantProfileId, subscriptionPlan);
    } catch (error) {
      return apiError({ tag: "[trials.POST]", error });
    }

    // #1527 Q4 — a DRAFT plan takes no new trial requests.
    if (planSaleRefusal(subscriptionPlan)) {
      return NextResponse.json(
        {
          error: "This plan isn't available to book right now.",
          code: "PLAN_NOT_PUBLISHED",
        },
        { status: 409 },
      );
    }

    // A paused expert takes no new booking, a trial included.
    if (subscriptionPlan.consultantProfile.acceptingRequests === false) {
      return bookingRuleResponse(
        new BookingRuleError(
          "NOT_ACCEPTING_BOOKINGS",
          "This expert is not taking new 1:1 bookings or trials right now. Pick another expert, or try again later.",
        ),
      );
    }

    if (!subscriptionPlan.trialEnabled) {
      return NextResponse.json(
        { error: "A trial is not available for this plan" },
        { status: 400 },
      );
    }

    // A paid trial holds its time until the capture confirms it; a free one
    // is confirmed with this request.
    const isPaidTrial = Number(subscriptionPlan.trialPriceInPaise ?? 0) > 0;
    // The pick is checked before a freed trial row is cleared below, so a
    // refused time never consumes the pair's slot.
    const startsAt = new Date(slot.startsAt);
    const endsAt = new Date(slot.endsAt);
    try {
      assertWindowMatchesPlanDuration(
        { trialDurationMinutes: subscriptionPlan.trialDurationMinutes },
        startsAt,
        endsAt,
      );
      assertRequestLeadFits(subscriptionPlan.trialPriceInPaise ?? 0, startsAt);
    } catch (error) {
      if (error instanceof BookingRuleError) return bookingRuleResponse(error);
      throw error;
    }

    // Check if a trial already exists for this consultee-consultant pair
    const existingTrial = await prisma.trial.findUnique({
      where: {
        consulteeProfileId_consultantProfileId: {
          consulteeProfileId,
          consultantProfileId,
        },
      },
    });

    // Only a live or already-delivered trial blocks a new request. A declined,
    // withdrawn or lapsed-unpaid trial frees the pair — never paying isn't the
    // same as having used your trial. The freed row must be deleted rather than
    // left in place, because the pair is @@unique. See lib/trials/eligibility.ts
    // for the abuse trade-off and how to tighten it if this gets gamed.
    if (existingTrial) {
      if (blocksNewTrialRequest(existingTrial.status)) {
        return NextResponse.json(
          {
            error: "You have already requested a trial with this consultant",
            code: "TRIAL_ALREADY_REQUESTED",
          },
          { status: 409 },
        );
      }
      // deleteMany, not delete: two requests can both read the same freed row
      // and both try to clear it, and the loser of that race gets P2025 — which
      // escapes to the generic catch as a 500, before the create-side unique
      // violation below can turn it into the calm 409 this pair already has an
      // answer for. A count of 0 means somebody else freed it; either way the
      // slot is clear and the insert decides who gets it.
      await prisma.trial.deleteMany({ where: { id: existingTrial.id } });
    }

    // Get consultee info for activity log
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeProfileId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    // Enterprise: if the caller passed `organizationId`, verify they're
    // an ACTIVE LEARNER member of that org before we stamp
    // attribution. This is org-tagging for analytics (conversion-rate
    // per org) — never a payment claim. Silently
    // dropping the field on membership mismatch would let a curious
    // user forge org-tagged trial attribution; we return 403 instead so
    // the client bug becomes obvious. `findFirst` with `userId`
    // resolves against the BetterAuth User id on the session.
    let resolvedOrgId: string | null = null;
    if (organizationId) {
      const membership = await prisma.membership.findFirst({
        where: {
          organizationId,
          userId: session.user.id,
          status: "ACTIVE",
          role: "LEARNER",
        },
        select: { id: true },
      });
      if (!membership) {
        return NextResponse.json(
          {
            error:
              "Only learners in an organisation can link a trial to it. Request the trial without the organisation.",
            code: "ORG_LEARNER_REQUIRED",
          },
          { status: 403 },
        );
      }
      resolvedOrgId = organizationId;
    }

    const consulteeUserId = consulteeProfile.user.id;
    const consultantUserId = subscriptionPlan.consultantProfile.user.id;
    // An expert taking a trial with another expert is busy on their own calendar too.
    const buyerConsultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: consulteeUserId },
      select: { id: true },
    });

    // Lock order: the expert's request cap (its count and the insert run
    // under it), then the consultee, then the slot atoms — checkout's order.
    // The pair is @@unique, so two concurrent requests for the same pair both
    // pass the eligibility read and race into the insert; the loser is the
    // same "already requested" answer the sequential path gives.
    let capLock: Awaited<ReturnType<typeof lockRequestCap>>;
    try {
      capLock = await lockRequestCap(consultantProfileId);
    } catch (error) {
      if (error instanceof RequestCapBusyError) {
        return NextResponse.json(
          {
            error: error.message,
            code: error.code,
            retryAfter: error.retryAfterSeconds,
          },
          { status: error.httpStatus },
        );
      }
      if (error instanceof BookingLockUnavailableError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.httpStatus },
        );
      }
      throw error;
    }
    let trial;
    let staged: StagedScheduleNotices | null = null;
    try {
      const release = await lockTrialPick({
        consulteeUserId,
        consultantProfileId,
        buyerConsultantProfileId: buyerConsultantProfile?.id,
        startsAt,
        endsAt,
      });
      try {
        const consultantName = subscriptionPlan.consultantProfile.user.name;
        // Rendered before the transaction: a free trial stages only its rows.
        const preparedEmails = isPaidTrial
          ? null
          : await prepareTrialScheduledEmail({
              // The dedupe key is set once the trial row exists.
              trialId: "pending",
              consulteeUserId,
              consultantUserId,
              consulteeName: consulteeProfile.user.name || "User",
              consultantName: consultantName || "Consultant",
              planTitle: subscriptionPlan.title,
              startsAt,
              awaitingPayment: false,
              dashboardUrl: `${getAppUrl()}${goHref("auto", "appointments")}`,
              paymentUrl: null,
            });
        const booked = await prisma
          .$transaction(async (tx) => {
            const atCapacity = await capacityRefusal(
              tx,
              subscriptionPlan.consultantProfile,
            );
            if (atCapacity) {
              throw new Refusal({
                code: atCapacity.code,
                userMessage: atCapacity.message,
              });
            }
            const created = await bookTrialInTx(tx, {
              consulteeProfileId,
              consultantProfileId,
              subscriptionPlanId,
              notes,
              organizationId: resolvedOrgId,
              consulteeUserId,
              consultantUserId,
              paid: isPaidTrial,
              startsAt,
              endsAt,
            });
            // The confirmation notices commit with the booking.
            const notices = preparedEmails
              ? await stageTrialScheduledNotices(tx, {
                  trialId: created.id,
                  consulteeUserId,
                  consultantUserId,
                  consulteeName: consulteeProfile.user.name || "User",
                  consultantName: consultantName || "Consultant",
                  planTitle: subscriptionPlan.title,
                  startsAt,
                  preparedEmails,
                })
              : null;
            return { created, notices };
          })
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) return null;
            throw error;
          });
        trial = booked?.created ?? null;
        staged = booked?.notices ?? null;
      } finally {
        await release();
      }
    } catch (error) {
      if (isRefusal(error)) return apiError({ tag: "[trials.POST]", error });
      if (error instanceof TrialTimeRefusedError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.httpStatus },
        );
      }
      // A confirmed session that met another at the database is the same lost race.
      if (isExclusionViolation(error)) {
        return NextResponse.json(
          {
            error: TRIAL_WINDOW_REFUSAL_COPY.SLOT_TAKEN,
            code: "SLOT_TAKEN",
          },
          { status: 409 },
        );
      }
      if (error instanceof SlotLockError) {
        return NextResponse.json(
          {
            error:
              "Someone else is booking that time right now. Pick another time or try again.",
            code: "SLOT_BUSY",
          },
          { status: 423 },
        );
      }
      if (error instanceof BookingLockUnavailableError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.httpStatus },
        );
      }
      throw error;
    } finally {
      await unlockRequestCap(capLock);
    }

    if (!trial) {
      return NextResponse.json(
        {
          error: "You have already requested a trial with this consultant",
          code: "TRIAL_ALREADY_REQUESTED",
        },
        { status: 409 },
      );
    }

    if (staged) {
      await flushNotificationsAfter(
        {
          bells: [staged.consulteeBell?.staged, staged.consultantBell?.staged],
          emails: [
            { list: staged.emails, emailType: "TRIAL_SESSION_SCHEDULED" },
          ],
        },
        "trials.booked",
      );
    }

    // Minted AFTER the commit (a gateway call never sits in a transaction);
    // a failed mint leaves the hold AWAITING_PAYMENT and the checkout page
    // re-mints while the pay window is open.
    const checkoutUrl = isPaidTrial
      ? await mintTrialRequestOrder(trial.id, trial.appointmentId, {
          userId: consulteeUserId,
          planId: subscriptionPlanId,
        })
      : null;

    return NextResponse.json({ data: trial, checkoutUrl }, { status: 201 });
  } catch (error) {
    console.error("Error creating trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while creating trial session" },
      { status: 500 },
    );
  }
}

/**
 * The paid trial's order, minted against the appointment that holds its
 * picked time and persisted as the pay page; the response hands the buyer the
 * branded trial checkout. Never throws: a lost mint is re-minted there.
 */
async function mintTrialRequestOrder(
  trialId: string,
  appointmentId: string,
  args: { userId: string; planId: string },
): Promise<string> {
  const checkoutPath = `/checkout/plans/trial/${trialId}`;
  try {
    const intent = await createApprovalPaymentIntent({
      userId: args.userId,
      appointmentType: "TRIAL",
      trialId,
      appointmentId,
      planId: args.planId,
      // #1165 — trial mints pin the KYC'd primary gateway.
      paymentGateway: PaymentGateway.RAZORPAY,
    });
    await persistTrialPayLink({
      trialId,
      paymentIntentId: intent.paymentIntentId,
      paymentId: intent.paymentId,
      checkoutUrl: intent.checkoutUrl,
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "trials",
      op: "trial-request-mint",
      extra: { trialId },
    });
  }
  return checkoutPath;
}
