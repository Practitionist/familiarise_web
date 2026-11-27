import { readJsonBody } from "@/lib/api/parse";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { assertRequestLeadFits } from "@/lib/booking/lead-time";
import prisma from "@/lib/prisma";
import { AppointmentStatus, type Prisma } from "@prisma/client";
import {
  lockSlotBatch,
  unlockSlotInterval,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  lockRequestCap,
  unlockRequestCap,
  renewConsulteeBooking,
  requestLockBudget,
  BookingLockUnavailableError,
  ConsulteeBookingBusyError,
  LockContentionError,
  RequestCapBusyError,
  type SlotBatchGrant,
} from "@/utils/appointmentlock";
import { SlotLockError } from "@/utils/errors/SlotLockError";
import { lockHostTimeInTx } from "@/lib/booking/allocation/host-time-locks";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import {
  prepareNewRequestNotices,
  stageNewRequestNotices,
  type StagedRequestNotices,
} from "@/lib/booking/request-notices";
import { PENDING_CONSULTATION_EXPIRATION_HOURS } from "@/scripts/appointments/expire-stale-requests";
import { scopedHref } from "@/lib/novu/resolve-href";
import { appendCreationHistory } from "@/lib/booking/transitions";
import { recordParticipants } from "@/lib/booking/participants";
import { PROFILE_WITH_USER_SELECT } from "@/lib/booking/list-selects";
import {
  buildOccurrenceForWindow,
  intervalStartsOf,
} from "@/lib/appointments/occurrences";
import {
  RequestForApprovalSchema,
  RequestIdempotencyKeySchema,
} from "@/schemas/slots";
import { requestApprovalLimiter, applyRateLimit } from "@/lib/rate-limit";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";
import {
  MAX_ACTIVE_REQUESTS_PER_USER,
  REQUEST_CAP_REACHED,
  capacityRefusal,
  countActiveConsultationRequests,
  pausedRefusal,
} from "@/lib/booking/request-caps";
import { planSaleRefusal } from "@/lib/api/plans/visibility";
import { assertWindowMatchesPlanDuration } from "@/lib/booking/slot-validation";
import {
  BookingRuleError,
  assertExpertVerified,
  assertPlanOnSale,
} from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { REQUEST_NOT_OFFERED_MESSAGE } from "@/lib/booking/booking-mode";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { assertSlotsStillPublished } from "@/lib/booking/allocation/coverage";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import {
  TRIAL_WINDOW_REFUSAL_COPY,
  TRIAL_WINDOW_REFUSAL_STATUS,
} from "@/lib/trials/slot-check";

import { getSession } from "@/lib/auth-server";
import { assertNotSelfBooking } from "@/lib/booking/self-booking";
import { assertExpertStandsInTx } from "@/lib/booking/expert-standing";
import { apiError } from "@/lib/errors/api-error";
import { isRefusal } from "@/lib/errors/refusal";
import * as Sentry from "@sentry/nextjs";

const SUBMITTED_MESSAGE = "Request for approval submitted successfully";

const REQUEST_RESPONSE_INCLUDE = {
  consultationPlan: {
    include: {
      consultantProfile: PROFILE_WITH_USER_SELECT,
    },
  },
  requestedBy: {
    include: {
      user: { select: { name: true } },
    },
  },
  appointment: {
    include: {
      occurrences: true,
    },
  },
} satisfies Prisma.ConsultationInclude;

interface AskedRequest {
  consultationPlanId: string;
  startsAt: string;
  endsAt: string;
  organizationId: string | null;
}

/** What the learner submitted, one spelling per instant, stored at creation. */
function requestFingerprintOf(asked: AskedRequest): string {
  const instant = (value: string) => {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  };
  return createHash("sha256")
    .update(
      JSON.stringify([
        asked.consultationPlanId,
        instant(asked.startsAt),
        instant(asked.endsAt),
        asked.organizationId ?? "",
      ]),
    )
    .digest("hex");
}

/**
 * The original 201 for a retried key, or null when the key has created nothing
 * yet; the same key with another plan, time or organisation is the caller's 422.
 */
async function replayRequest(
  idempotencyKey: string | null,
  userId: string,
  asked: AskedRequest,
): Promise<NextResponse | null> {
  if (!idempotencyKey) return null;
  const original = await prisma.consultation.findUnique({
    where: { requestIdempotencyKey: idempotencyKey },
    include: REQUEST_RESPONSE_INCLUDE,
  });
  if (!original) return null;
  // Compared with what was submitted, never the booking's current times; a row
  // created before the fingerprint compares its held times instead.
  const held = (original.appointment?.occurrences ?? []).filter(
    (o) => !o.deletedAt,
  );
  const sameBody = original.requestFingerprint
    ? original.requestFingerprint === requestFingerprintOf(asked)
    : original.consultationPlanId === asked.consultationPlanId &&
      (original.appointment?.organizationId ?? null) === asked.organizationId &&
      held.length > 0 &&
      Math.min(...held.map((o) => o.startsAt.getTime())) ===
        Date.parse(asked.startsAt) &&
      Math.max(...held.map((o) => o.endsAt.getTime())) ===
        Date.parse(asked.endsAt);
  if (original.requestedBy.userId !== userId || !sameBody) {
    return NextResponse.json(
      {
        error:
          "This Idempotency-Key was already used with a different request body.",
        code: "IDEMPOTENCY_KEY_REUSED",
      },
      { status: 422 },
    );
  }
  return NextResponse.json(
    { message: SUBMITTED_MESSAGE, data: original },
    { status: 201 },
  );
}

/** A refusal decided inside the request transaction; nothing was written. */
class RequestRefusal extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error));
    this.name = "RequestRefusal";
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // Rate limit: 10 approval requests per hour per user
    const rl = await applyRateLimit(requestApprovalLimiter, session.user.id);
    if (rl) return rl;

    const rawKey = req.headers.get("Idempotency-Key");
    const keyResult =
      rawKey === null ? null : RequestIdempotencyKeySchema.safeParse(rawKey);
    if (keyResult && !keyResult.success) {
      return NextResponse.json(
        {
          error: "Invalid Idempotency-Key header",
          details: keyResult.error.issues,
        },
        { status: 400 },
      );
    }
    const idempotencyKey = keyResult?.data ?? null;

    const read = await readJsonBody(req);
    if (read.error) return read.error;
    const body = read.body;
    const parseResult = RequestForApprovalSchema.safeParse(body);
    if (!parseResult.success) {
      // #1583 E-P1-03 — a typed refusal (grid / lead time) rides `params.code`.
      const typed = parseResult.error.issues.find(
        (issue) => issue.code === "custom" && !!issue.params?.code,
      );
      const typedCode =
        typed?.code === "custom" ? String(typed.params?.code) : null;
      return NextResponse.json(
        {
          error: typed?.message ?? "Validation failed",
          ...(typedCode ? { code: typedCode } : {}),
          details: parseResult.error.issues,
        },
        { status: 400 },
      );
    }
    const {
      consultantProfileId,
      startsAt,
      endsAt,
      availabilityWindowWeeklyId,
      availabilityWindowCustomId,
      consultationPlanId,
      organizationId,
    } = parseResult.data;
    const asked = {
      consultationPlanId,
      startsAt,
      endsAt,
      organizationId: organizationId ?? null,
    };
    const replayed = await replayRequest(
      idempotencyKey,
      session.user.id,
      asked,
    );
    if (replayed) return replayed;

    // #1166 ORG-9 — org sponsorship was silently dropped by the approval flow:
    // the request carried no org, so the approved booking billed the member's
    // personal card with no wallet debit, seat consumption, or attribution.
    // The request now carries it, stamped onto the Appointment below; the
    // approval pay-link and Payment row inherit it from there.
    if (organizationId) {
      const [org, membership] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: organizationId },
          select: { canSponsor: true, status: true },
        }),
        prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: session.user.id,
              organizationId,
            },
          },
          select: { status: true, role: true },
        }),
      ]);
      // Same gate the checkout path applies: PENDING_VERIFICATION orgs may
      // still transact, anything else (suspended/inactive) may not. Without
      // it a suspended org rides the Appointment and then the Payment row,
      // and nothing re-checks status downstream.
      const orgTransactable =
        org?.status === "ACTIVE" || org?.status === "PENDING_VERIFICATION";
      if (
        !org?.canSponsor ||
        !orgTransactable ||
        membership?.status !== "ACTIVE"
      ) {
        return NextResponse.json(
          {
            error:
              "This organization cannot sponsor your booking (it is not a sponsor org, it is not in good standing, or you are not an active member).",
          },
          { status: 403 },
        );
      }
      if (membership.role !== "LEARNER") {
        return NextResponse.json(
          {
            error: "Sponsored seats are for learners in your organisation",
            code: "SPONSOR_SEAT_ROLE",
          },
          { status: 409 },
        );
      }
    }

    const startTime = new Date(startsAt);
    const endTime = new Date(endsAt);

    // Lazy-create ConsulteeProfile on first consumer action — org-workspace
    // operators and consultants who book approvals will otherwise 404 here.
    await ensureConsulteeProfile(prisma, session.user.id);
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
      // The name the expert's notice shows.
      include: { user: { select: { name: true } } },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    // Verify the consultation plan exists and belongs to the consultant
    const consultationPlan = await prisma.consultationPlan.findFirst({
      where: {
        id: consultationPlanId,
        consultantProfileId: consultantProfileId,
      },
      include: {
        consultantProfile: {
          select: {
            id: true,
            acceptingRequests: true,
            bookingMode: true,
            maxOpenRequests: true,
            verificationStatus: true,
            deletedAt: true,
            // The id seats the expert; the name greets them in the request's notice.
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    // A soft-deleted expert's plan answers as missing, as checkout does.
    if (!consultationPlan || consultationPlan.consultantProfile.deletedAt) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }

    try {
      assertNotSelfBooking(session.user.consultantProfileId, consultationPlan);
    } catch (error) {
      return apiError({ tag: "[request-for-approval]", error });
    }

    // #1527 Q4 — a DRAFT plan takes no new requests.
    if (planSaleRefusal(consultationPlan)) {
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
      assertExpertVerified(
        consultationPlan.consultantProfile,
        "This consultation",
      );
      assertPlanOnSale(consultationPlan, "This consultation", organizationId);
    } catch (error) {
      if (error instanceof BookingRuleError) return bookingRuleResponse(error);
      if (isRefusal(error)) {
        return apiError({ tag: "[request-for-approval]", error });
      }
      throw error;
    }

    // #1703 D4 — the pause is a profile switch, so it is answered before any
    // lock is taken; the cap needs a count and runs inside the slot lock.
    const paused = pausedRefusal(consultationPlan.consultantProfile);
    if (paused) {
      return NextResponse.json(
        { error: paused.message, code: paused.code },
        { status: 409 },
      );
    }

    // An instant-booking expert sells a free time at checkout; a held one is taken.
    if (consultationPlan.consultantProfile.bookingMode !== "REQUEST") {
      return bookingRuleResponse(
        new BookingRuleError(
          "REQUEST_NOT_OFFERED",
          REQUEST_NOT_OFFERED_MESSAGE,
        ),
      );
    }

    try {
      assertWindowMatchesPlanDuration(consultationPlan, startTime, endTime);
      assertRequestLeadFits(consultationPlan.price, startTime);
    } catch (err) {
      if (err instanceof BookingRuleError) return bookingRuleResponse(err);
      throw err;
    }

    if (availabilityWindowWeeklyId && availabilityWindowCustomId) {
      return NextResponse.json(
        {
          error:
            "Provide either availabilityWindowWeeklyId or availabilityWindowCustomId, not both.",
          code: "AMBIGUOUS_AVAILABILITY_WINDOW",
        },
        { status: 400 },
      );
    }

    if (availabilityWindowWeeklyId) {
      const weeklyWindow = await prisma.availabilityWindowWeekly.findFirst({
        where: { id: availabilityWindowWeeklyId, consultantProfileId },
        select: { id: true },
      });
      if (!weeklyWindow) {
        return NextResponse.json(
          {
            error: "Availability window not found for this consultant",
            code: "INVALID_AVAILABILITY_WINDOW",
          },
          { status: 400 },
        );
      }
    }

    if (availabilityWindowCustomId) {
      const customWindow = await prisma.availabilityWindowCustom.findFirst({
        where: { id: availabilityWindowCustomId, consultantProfileId },
        select: { id: true },
      });
      if (!customWindow) {
        return NextResponse.json(
          {
            error: "Availability window not found for this consultant",
            code: "INVALID_AVAILABILITY_WINDOW",
          },
          { status: 400 },
        );
      }
    }

    // Create request notes with availability slot information
    const requestNotes =
      `Request for approval - Slot: ${startTime.toISOString()} to ${endTime.toISOString()}. ` +
      `Availability slot: ${availabilityWindowWeeklyId ? `Weekly ID: ${availabilityWindowWeeklyId}` : `Custom ID: ${availabilityWindowCustomId}`}`;

    // DISTRIBUTED LOCKS: serialize on the CONSULTEE first, then the slot
    // atoms. Order matters: direct checkout takes consultee → slot atoms
    // (lib/payments/checkout/orchestrate.ts), so this route must use the same
    // order — the reverse would let a checkout holding the consultee lock
    // wait on atoms this route holds while it waits on the consultee lock
    // (classic ABBA). The consultee arm is the piece the audit flagged (B8a):
    // without it the same user could race this route against their own
    // checkout on a DIFFERENT consultant and double-book themselves — the
    // GiST guard is consultant-keyed and cannot see it.
    let requestCapLock: Awaited<ReturnType<typeof lockRequestCap>> | null =
      null;
    let consulteeLock: Awaited<ReturnType<typeof lockConsulteeBooking>> | null =
      null;
    let lock: SlotBatchGrant | undefined;
    let stagedNotices: StagedRequestNotices | undefined;
    let createdConsultation:
      Awaited<ReturnType<typeof prisma.consultation.create>> | undefined;

    try {
      // Lock order: request cap (consultant tier) → consultee → slot batch.
      // The cap's count and the insert below both run under it.
      // One deadline for all three tiers: a wait on one is not available to the next.
      const lockBudget = requestLockBudget();
      requestCapLock = await lockRequestCap(
        consultantProfileId,
        undefined,
        lockBudget,
      );
      consulteeLock = await lockConsulteeBooking(
        session.user.id,
        undefined,
        lockBudget,
      );

      // Under the consultee lock, so a concurrent same-key retry sees the first commit.
      const replayedInLock = await replayRequest(
        idempotencyKey,
        session.user.id,
        asked,
      );
      if (replayedInLock) return replayedInLock;

      // Anti-scalper cap (booking-journey audit B1): every PENDING request
      // holds a tentative slot that blocks the consultant's calendar. The
      // count runs INSIDE the consultee lock — outside it, two concurrent
      // submits both read n<3 and both insert, landing at 4+ active holds
      // (CodeRabbit triage on the TOCTOU).
      const activeRequests = await countActiveConsultationRequests(
        prisma,
        consulteeProfile.id,
      );
      if (activeRequests >= MAX_ACTIVE_REQUESTS_PER_USER) {
        return NextResponse.json(
          {
            error: REQUEST_CAP_REACHED.message,
            code: REQUEST_CAP_REACHED.code,
          },
          { status: 429 },
        );
      }

      try {
        // ACQUIRE LOCK for the whole requested interval (#1169 PR 1 — one key
        // per 30-min atom, so overlapping requests with different starts collide)
        // Use default 60s TTL (15s was too short for slow database operations)
        // An expert booking another expert also holds their own calendar's atoms.
        const slotEntries = [
          { consultantProfileId, startsAt, endsAt },
          ...(session.user.consultantProfileId &&
          session.user.consultantProfileId !== consultantProfileId
            ? [
                {
                  consultantProfileId: session.user.consultantProfileId,
                  startsAt,
                  endsAt,
                },
              ]
            : []),
        ];
        lock = await lockSlotBatch(slotEntries, undefined, lockBudget);

        console.log(
          JSON.stringify({
            event: "slot_booking_lock_acquired",
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            timestamp: new Date().toISOString(),
          }),
        );

        // The 30-minute interval starts the window covers — the validator's
        // unit of arithmetic (#1554: the persisted shape is one row below).
        if (!(startTime < endTime)) {
          return NextResponse.json(
            { error: "Invalid slot: start time must be before end time" },
            { status: 400 },
          );
        }
        const occurrenceToCreate = buildOccurrenceForWindow({
          startsAt: startTime,
          endsAt: endTime,
          // #440 — the overlap-guard column must be set at CREATE time even on
          // tentative rows: approval/webhook confirm flips isTentative via
          // updateMany, so whatever is on the row rides into confirmed state.
          consultantProfileId,
          isTentative: true, // pending approval
        });
        const slotChunkStarts = intervalStartsOf(occurrenceToCreate);

        // CRITICAL SECTION: Create consultation (protected by lock AND validated)
        // #1333 — the request and its opening timeline row commit together, so
        // a booking that exists is never one the staff timeline has nothing to
        // say about. The nested create was already atomic on its own; the
        // transaction is what extends that atomicity to the audit row. The
        // budget sits well inside the 60 s slot lock held above.
        // The expert's notices are read and rendered here, outside the
        // transaction, and staged inside it. ADR 23: one recipient with a
        // known side gets a precise route.
        const reviewUrl = scopedHref({
          organizationId: organizationId ?? null,
          surface: "requests",
          personal: { kind: "consultant", profileId: consultantProfileId },
        });
        const sweepExpiry = new Date(
          Date.now() + PENDING_CONSULTATION_EXPIRATION_HOURS * 60 * 60 * 1000,
        );
        const preparedNotices = await prepareNewRequestNotices({
          consultantUserId: consultationPlan.consultantProfile.user.id,
          consultantName:
            consultationPlan.consultantProfile.user.name || "Consultant",
          consulteeName: consulteeProfile.user.name || "A consultee",
          planTitle: consultationPlan.title,
          organizationId: organizationId ?? null,
          startsAt: startTime,
          respondBy: sweepExpiry < startTime ? sweepExpiry : startTime,
          reviewUrl,
        });

        // Re-armed for this one attempt; a grant that is no longer ours writes nothing.
        await renewConsulteeBooking(consulteeLock);
        const requested = await prisma.$transaction(
          async (tx) => {
            // The database arbitrates the window before any row is locked or read.
            await lockHostTimeInTx(
              tx,
              slotEntries,
              (held) =>
                new RequestRefusal(409, {
                  error:
                    held.consultantProfileId === consultantProfileId
                      ? "Slot no longer available"
                      : "You already have a session booked during this time.",
                  code: "SLOT_TAKEN",
                  conflicts: 1,
                }),
            );
            // Standing, mode, cap and availability are read on this transaction, after
            // every lock, so the insert below commits against what they saw.
            const standing = await assertExpertStandsInTx(
              tx,
              consultantProfileId,
              "This consultation",
            );
            // The pause, the mode and the cap are the locked row's: a change
            // committed while this request waited for its locks decides.
            const settings = standing ?? consultationPlan.consultantProfile;
            const pausedNow = pausedRefusal(settings);
            if (pausedNow) {
              throw new RequestRefusal(409, {
                error: pausedNow.message,
                code: pausedNow.code,
              });
            }
            if (settings.bookingMode !== "REQUEST") {
              throw new RequestRefusal(409, {
                error: REQUEST_NOT_OFFERED_MESSAGE,
                code: "REQUEST_NOT_OFFERED",
              });
            }
            const atCapacity = await capacityRefusal(tx, {
              id: consultantProfileId,
              maxOpenRequests: settings.maxOpenRequests,
            });
            if (atCapacity) {
              throw new RequestRefusal(409, {
                error: atCapacity.message,
                code: atCapacity.code,
              });
            }
            // A request is checked against published hours here only; once
            // held, it keeps its time for every approver.
            await assertSlotsStillPublished(
              tx,
              consultantProfileId,
              slotChunkStarts,
            ).catch((error: unknown) => {
              if (
                error instanceof AllocationConflictError &&
                error.errorCode === "AVAILABILITY_CHANGED"
              ) {
                throw new RequestRefusal(
                  TRIAL_WINDOW_REFUSAL_STATUS.OUTSIDE_AVAILABILITY,
                  {
                    error: TRIAL_WINDOW_REFUSAL_COPY.OUTSIDE_AVAILABILITY,
                    code: "OUTSIDE_AVAILABILITY",
                  },
                );
              }
              throw error;
            });
            const validation = await new ScheduleValidationService(
              tx,
            ).checkSlotAvailability(
              slotChunkStarts,
              consultationPlan.consultantProfile.user.id,
              consultantProfileId,
              session.user.id,
            );
            if (!validation.isValid) {
              console.log(
                JSON.stringify({
                  event: "slot_booking_validation_failed",
                  consultant: consultantProfileId,
                  slot: startsAt,
                  user: session.user.id,
                  errors: validation.errors,
                  timestamp: new Date().toISOString(),
                }),
              );
              // A clash off the expert's calendar is the requester's own.
              const ownOverlap = validation.conflicts?.some(
                (c) => !c.onConsultantCalendar,
              );
              throw new RequestRefusal(409, {
                error: ownOverlap
                  ? "You already have a session booked during this time."
                  : "Slot no longer available",
                code: "SLOT_TAKEN",
                conflicts:
                  validation.conflicts?.length ?? validation.errors.length,
              });
            }
            const created = await tx.consultation.create({
              data: {
                consultationPlanId: consultationPlanId,
                requestedById: consulteeProfile.id,
                status: AppointmentStatus.PENDING,
                requestNotes: requestNotes,
                requestIdempotencyKey: idempotencyKey,
                requestFingerprint: idempotencyKey
                  ? requestFingerprintOf(asked)
                  : null,
                agreedPricePaise: consultationPlan.price,
                appointment: {
                  create: {
                    appointmentType: "CONSULTATION",
                    // #1166 ORG-9 — org attribution rides the appointment from
                    // the moment the request exists.
                    organizationId: organizationId ?? null,
                    occurrences: {
                      create: occurrenceToCreate,
                    },
                  },
                },
              },
              include: REQUEST_RESPONSE_INCLUDE,
            });
            // #1544 / #1554 — the roster is born with the request: this was the
            // one creation path that never wrote AppointmentParticipant.
            if (created.appointment) {
              await recordParticipants(
                tx,
                created.appointment.id,
                [
                  {
                    userId: consultationPlan.consultantProfile.user.id,
                    role: "CONSULTANT",
                  },
                  { userId: session.user.id, role: "CONSULTEE" },
                ],
                { organizationId: organizationId ?? null, status: "HELD" },
              );
            }
            await appendCreationHistory(
              tx,
              "CONSULTATION",
              created.id,
              AppointmentStatus.PENDING,
              {
                appointmentId: created.appointment?.id ?? null,
                actorUserId: session.user.id,
                organizationId: created.appointment?.organizationId ?? null,
              },
            );
            // The notices commit with the request, keyed by it.
            const notices = await stageNewRequestNotices(
              tx,
              created.id,
              preparedNotices,
            );
            return { created, notices };
          },
          { maxWait: 10_000, timeout: 15_000 },
        );
        const consultation = requested.created;
        stagedNotices = requested.notices;

        console.log(
          JSON.stringify({
            event: "slot_booking_success",
            consultationId: consultation.id,
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            timestamp: new Date().toISOString(),
          }),
        );

        createdConsultation = consultation;
      } catch (lockError) {
        if (lockError instanceof RequestRefusal) {
          return NextResponse.json(lockError.body, {
            status: lockError.httpStatus,
          });
        }
        if (lockError instanceof BookingRuleError) {
          return bookingRuleResponse(lockError);
        }
        console.error(
          JSON.stringify({
            event: "slot_booking_error",
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            error:
              lockError instanceof Error ? lockError.message : "Unknown error",
            timestamp: new Date().toISOString(),
          }),
        );

        if (isUniqueViolationOn(lockError, "requestIdempotencyKey")) {
          const replayedRace = await replayRequest(
            idempotencyKey,
            session.user.id,
            asked,
          );
          if (replayedRace) return replayedRace;
        }

        // #1169 PR 1 — Redis-down fails closed with a structured 503; without
        // this branch the outage fell through to the generic 500 below.
        if (lockError instanceof BookingLockUnavailableError) {
          return NextResponse.json(
            { error: lockError.message },
            { status: lockError.httpStatus },
          );
        }

        // Check if error is lock acquisition failure (type-safe)
        if (lockError instanceof SlotLockError) {
          return NextResponse.json(
            {
              error: lockError.message,
              retryAfter: lockError.retryAfterSeconds,
            },
            { status: 409 }, // 409 Conflict
          );
        }

        // The consultee key's busy answer is mapped by the outer handler.
        if (lockError instanceof ConsulteeBookingBusyError) throw lockError;

        Sentry.captureException(
          lockError instanceof Error ? lockError : new Error(String(lockError)),
          { tags: { subsystem: "scheduling" } },
        );
        throw lockError; // Re-throw other errors for general error handler
      } finally {
        // ALWAYS release lock (even on error)
        if (lock) {
          await unlockSlotInterval(lock);
          console.log(
            JSON.stringify({
              event: "slot_booking_lock_released",
              consultant: consultantProfileId,
              slot: startsAt,
              user: session.user.id,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    } finally {
      // Release in reverse acquisition order.
      if (consulteeLock) {
        await unlockConsulteeBooking(consulteeLock);
      }
      if (requestCapLock) {
        await unlockRequestCap(requestCapLock);
      }
    }

    await flushNotificationsAfter(
      {
        bells: stagedNotices?.bells ?? [],
        emails: [
          {
            rows: stagedNotices?.emails ?? [],
            emailType: "NEW_BOOKING_REQUEST",
            budgetMs: EMAIL_BUDGET_MS.REQUEST,
          },
        ],
      },
      "scheduling.request-for-approval",
    );

    return NextResponse.json(
      {
        message: SUBMITTED_MESSAGE,
        data: createdConsultation,
      },
      { status: 201 },
    );
  } catch (error) {
    // Consultee-lock failures surface here (the inner catch only wraps the
    // slot-atom section). Map them to the SAME structured responses the slot
    // arm uses — a raw 500 for "someone else is booking as you" reads as our
    // fault and hides the retry (CodeRabbit triage).
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.httpStatus },
      );
    }
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
    if (
      error instanceof ConsulteeBookingBusyError ||
      error instanceof LockContentionError ||
      error instanceof SlotLockError
    ) {
      return NextResponse.json(
        {
          error:
            "Another booking request is in progress for your account. Please try again in a moment.",
          retryAfter: 30,
        },
        { status: 409 },
      );
    }

    console.error("Error creating approval request:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    return NextResponse.json(
      { error: "An error occurred while creating the approval request" },
      { status: 500 },
    );
  }
}
