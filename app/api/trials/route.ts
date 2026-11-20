import { readJsonBody } from "@/lib/api/parse";
import { isStaffNonParty, publicRequester } from "@/lib/booking/list-selects";
import prisma from "@/lib/prisma";
import {
  blockingTrialWhere,
  TRIAL_PAIR_BLOCKING_INDEX,
} from "@/lib/trials/eligibility";
import { PaymentGateway, Prisma, TrialStatus } from "@prisma/client";
import { createApprovalPaymentIntent } from "@/lib/payments/operations/approval-payment";
import { persistTrialPayLink } from "@/lib/trials/pay-link";
import {
  bookTrialInTx,
  lockTrialPick,
  TrialDailyLimitError,
  TrialPairHeldError,
  TrialTimeRefusedError,
} from "@/lib/trials/book-trial";
import {
  prepareTrialScheduledNotices,
  stageTrialScheduledNotices,
  type StagedScheduleNotices,
} from "@/lib/trials/schedule-notices";
import { TRIAL_WINDOW_REFUSAL_COPY } from "@/lib/trials/slot-check";
import { reportSentryError } from "@/lib/observability/report";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { CreateTrialSchema } from "@/schemas/trials";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  resolveOrgScope,
  scopeToPlanHostWhere,
  scopeToWhereOrgId,
} from "@/lib/api/scope/parse";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { planSaleRefusal } from "@/lib/api/plans/visibility";
import {
  BookingRuleError,
  assertExpertVerified,
  assertPlanOnSale,
} from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { assertRequestLeadFits } from "@/lib/booking/lead-time";
import { slotStartRefusal } from "@/lib/payments/utils/slot-validation";
import { assertWindowMatchesPlanDuration } from "@/lib/booking/slot-validation";
import { assertNotSelfBooking } from "@/lib/booking/self-booking";
import { assertExpertStandsInTx } from "@/lib/booking/expert-standing";
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
  // An unknown or removed status is the caller's error, never a Prisma one.
  const statusParse = z
    .nativeEnum(TrialStatus)
    .nullable()
    .safeParse(searchParams.get("status"));
  if (!statusParse.success) {
    return NextResponse.json(
      { error: "Invalid trial status" },
      { status: 400 },
    );
  }
  const status = statusParse.data;
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

    // STAFF read the learner of a trial they are not a party to in the public shape.
    const data = trials.map((trial) =>
      isStaffNonParty(
        session.user.role,
        trial.consulteeProfileId === session.user.consulteeProfileId ||
          trial.consultantProfileId === session.user.consultantProfileId,
      )
        ? {
            ...trial,
            consulteeProfile: publicRequester(trial.consulteeProfile),
          }
        : trial,
    );
    return NextResponse.json({
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "trials",
      op: "GET /api/trials",
      expected: false,
    });
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

    const read = await readJsonBody(request);
    if (read.error) return read.error;
    const body = read.body;
    const result = CreateTrialSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          code: "VALIDATION_FAILED",
          details: result.error.issues,
        },
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

    const subscriptionPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: {
          select: {
            id: true,
            acceptingRequests: true,
            maxOpenRequests: true,
            verificationStatus: true,
            deletedAt: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    // A soft-deleted expert's plan answers as missing, as checkout does.
    if (!subscriptionPlan || subscriptionPlan.consultantProfile.deletedAt) {
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

    // Checkout's sale gates: a verified expert, a plan on sale to this buyer.
    try {
      assertExpertVerified(subscriptionPlan.consultantProfile, "This trial");
      assertPlanOnSale(subscriptionPlan, "This trial", organizationId);
    } catch (error) {
      if (error instanceof BookingRuleError) return bookingRuleResponse(error);
      if (isRefusal(error)) return apiError({ tag: "[trials.POST]", error });
      throw error;
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
    // The 1:1 edge every buyer door shares: the half-hour grid and the booking horizon.
    const edge = slotStartRefusal(startsAt);
    if (edge) {
      return NextResponse.json(
        { error: edge.message, code: edge.code },
        { status: 400 },
      );
    }

    // An earlier ended trial stays as it is; only one that holds the pair refuses.
    const blockingTrial = await prisma.trial.findFirst({
      where: blockingTrialWhere({ consulteeProfileId, consultantProfileId }),
      orderBy: { requestedAt: "desc" },
      select: { id: true },
    });
    if (blockingTrial) {
      return NextResponse.json(
        {
          error: "You have already requested a trial with this consultant",
          code: "TRIAL_ALREADY_REQUESTED",
        },
        { status: 409 },
      );
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
    // A rival request for the pair that passed the read above is refused by
    // the in-transaction recheck or the pair index, with the same 409.
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
        // Read and rendered before the transaction: a free trial stages only its rows.
        const prepared = isPaidTrial
          ? null
          : await prepareTrialScheduledNotices({
              consulteeUserId,
              consultantUserId,
              consulteeName: consulteeProfile.user.name || "User",
              consultantName:
                subscriptionPlan.consultantProfile.user.name || "Consultant",
              planTitle: subscriptionPlan.title,
              startsAt,
            });
        const booked = await prisma
          .$transaction(
            async (tx) => {
              // Read under a share lock, so a reject that lands meanwhile waits for this write.
              await assertExpertStandsInTx(
                tx,
                consultantProfileId,
                "This trial",
              );
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
                agreedPricePaise: subscriptionPlan.trialPriceInPaise,
                startsAt,
                endsAt,
              });
              // The confirmation notices commit with the booking.
              const notices = prepared
                ? await stageTrialScheduledNotices(tx, created.id, prepared)
                : null;
              return { created, notices };
            },
            { maxWait: 10_000, timeout: 15_000 },
          )
          .catch((error: unknown) => {
            if (
              error instanceof TrialPairHeldError ||
              isUniqueViolationOn(error, TRIAL_PAIR_BLOCKING_INDEX)
            ) {
              return null;
            }
            throw error;
          });
        trial = booked?.created ?? null;
        staged = booked?.notices ?? null;
      } finally {
        await release();
      }
    } catch (error) {
      if (isRefusal(error)) return apiError({ tag: "[trials.POST]", error });
      if (error instanceof BookingRuleError) return bookingRuleResponse(error);
      if (error instanceof TrialDailyLimitError) {
        const retryAfter = Math.max(
          1,
          Math.ceil((error.retryAt.getTime() - Date.now()) / 1000),
        );
        return NextResponse.json(
          {
            error: error.message,
            code: "RATE_LIMITED",
            retryAfterSeconds: retryAfter,
            retryAt: error.retryAt.toISOString(),
          },
          {
            status: 429,
            headers: {
              "X-RateLimit-Remaining": "0",
              "Retry-After": String(retryAfter),
            },
          },
        );
      }
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
          bells: staged.bells,
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
    reportSentryError(error, {
      subsystem: "trials",
      op: "POST /api/trials",
      expected: false,
    });
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
