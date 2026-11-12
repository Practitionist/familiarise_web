import { PROFILE_OWNER_SELECT } from "@/lib/booking/list-selects";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  isActiveOrgExpert,
  NOT_ACTIVE_ORG_EXPERT_REFUSAL,
} from "@/lib/enterprise/membership-guards";
import { refuseForeignProfileReassignment } from "@/lib/api/plans/profile-reassignment";
import { recordParticipants } from "@/lib/booking/participants";
import {
  expireEventWaitlistForPlan,
  finishSeatOpenedNotices,
  stageSeatOpenedNotices,
  type StagedSeatOpened,
} from "@/lib/booking/event-waitlist";
import { scheduleAfter } from "@/lib/api/after-safe";
import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import {
  curriculumCreateNested,
  faqCreateNested,
  faqReplaceNested,
} from "@/lib/api/plans/content";
import { ClassPlanSchema, ClassContentSchema } from "@/schemas/plans";
import { editorStatusOrRefusal } from "@/lib/api/plans/event-status";
import { refundWindowHoursSchema } from "@/lib/booking/refund-window";
import { ClassStatus, Prisma } from "@prisma/client";
import {
  EVENT_PUBLISHABLE_FROM,
  transitionClassEvent,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addMonths } from "date-fns";
import { findOrCreateTopics, transformNestedPlanTopics } from "@/lib/topics";
import { checkConsultantVerification } from "@/lib/verification";
import { countWebinarParticipants } from "@/lib/payments/utils/participants";
import {
  CapacityBelowEnrollmentError,
  capacityBelowRegisteredMessage,
  capacityOverrideFor,
  effectiveMaxParticipants,
} from "@/lib/events/capacity";

import { getSession } from "@/lib/auth-server";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import { seriesStartsFrom } from "@/lib/booking/class-pattern";
import { eventTimeRefusal } from "@/lib/booking/event-time-rules";
import { buildOccurrence } from "@/lib/appointments/occurrences";
import {
  assertCollaboratorsAvailableForWindows,
  assertConsultantAvailableForWindows,
  CollaboratorUnavailableError,
  ConsultantScheduleConflictError,
} from "@/lib/collaborators/availability";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  BookingLockUnavailableError,
  EventCheckoutBusyError,
  EventCheckoutLockUnavailableError,
  withEventCheckoutLock,
} from "@/utils/appointmentlock";
import {
  acceptedCohostProfileIds,
  hostBatchEntries,
  withHostSlotBatch,
} from "@/lib/booking/host-slot-batch";
import {
  ScheduleLockedError,
  CLASS_SCHEDULE_LOCKED_MESSAGE,
} from "@/lib/events/schedule-lock";
import { planTotalSessions } from "@/lib/booking/entitlement";
// Schema for class content input (without Prisma-managed fields like createdAt, updatedAt, classPlanId)
const ClassContentInputSchema = ClassContentSchema.omit({
  createdAt: true,
  updatedAt: true,
  classPlanId: true,
});

// Schema for POST request body based on ClassPlanSchema
// Topics are now accepted as names (strings) - API handles finding/creating
const PostClassWithPlanBodySchema = ClassPlanSchema.omit({
  planType: true,
  consultantProfile: true,
  // The form's Date-valued field; this endpoint takes an ISO `startDate`
  // string, re-declared below.
  schedulingStartDate: true,
  endDate: true,
  topics: true,
  classContents: true, // Omit to override with input schema
}).extend({
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  // #1780 row 2 — the plan's free-cancellation window (24–168 h).
  refundWindowHours: refundWindowHoursSchema,
  // Topics as names - API will find or create them
  topics: z
    .array(z.string().min(1, "Topic name cannot be empty"))
    .min(1, "At least one topic is required"),
  // Defaults to SCHEDULED with a startDate and DRAFT without one.
  status: z.nativeEnum(ClassStatus).optional(),
  startDate: z
    .string()
    .optional()
    .nullable()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for startDate",
    }),
  // Override classContents with input schema (without Prisma-managed date fields)
  classContents: z
    .array(ClassContentInputSchema)
    .min(1, "At least one class content item is required")
    .default([])
    .refine((contents) => {
      const titles = contents.map((c) => c.title.trim().toLowerCase());
      return new Set(titles).size === titles.length;
    }, "Class contents must have unique titles"),
});

// Schema for PATCH request body
// Makes most fields optional, requires plan 'id', adds 'classId'
const PatchClassWithPlanBodySchema =
  PostClassWithPlanBodySchema.partial().extend({
    id: z.string().min(1, "Class Plan ID is required for update"), // Plan ID is required
    classId: z.string().optional().nullable(), // Class Instance ID is optional
    status: z.unknown().optional(),
    // topics is already optional via partial()
    // Add endDate specific to PATCH updates
    endDate: z
      .string()
      .optional()
      .nullable()
      .refine((val) => !val || !isNaN(Date.parse(val)), {
        message: "Invalid date format for endDate",
      }),
  });

/** #1819 — a cutoff past the last session is a 400, not a silent clamp. */
function lateJoinCutoffRefusal(
  value: number | null | undefined,
  totalSessions: number,
): NextResponse | null {
  if (value === null || value === undefined || value <= totalSessions)
    return null;
  return NextResponse.json(
    {
      error: `Late joining can run until session ${totalSessions} at most, because this class has ${totalSessions} sessions.`,
    },
    { status: 400 },
  );
}

/**
 * Creates a ClassPlan along with an optional scheduled or draft Class instance and its session occurrences.
 */
export async function POST(request: NextRequest) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await request.json();

    // Verification check - consultant must be verified to create classes
    if (body.consultantProfileId) {
      const verification = await checkConsultantVerification(
        body.consultantProfileId,
      );
      if (!verification.isVerified) {
        return NextResponse.json(
          {
            error: "Verification required",
            message: verification.message,
            verificationStatus: verification.status,
          },
          { status: 403 },
        );
      }
    }

    // --- Zod Validation ---
    const validationResult = PostClassWithPlanBodySchema.safeParse(body);

    if (!validationResult.success) {
      console.error("Validation Error (POST):", validationResult.error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;
    const {
      title,
      description,
      durationInMonths,
      price,
      priceCurrency,
      maxParticipants,
      refundWindowHours,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      subtitle,
      targetAudience,
      whatsIncluded,
      faqs,
      consultantProfileId,
      topics: topicNames,
      certificateProvided,
      waitlistEnabled,
      waitlistMax,
      recordingEnabled,
      sessionsPerWeek,
      emailSupport,
      classContents,
      status,
      startDate,
      lateJoinUntilSession,
      lateJoinersGetPastRecordings,
    } = validatedData;

    // Verify ownership - user must own this consultant profile
    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: {
        id: consultantProfileId,
        userId: session.user.id,
      },
      // #1076 — the host's zone is what the per-day/week caps bucket on.
      include: { user: { select: { timezone: true } } },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        {
          error:
            "You do not have permission to create classes for this consultant profile",
        },
        { status: 403 },
      );
    }

    // Find or create topics by name
    const topicIds = await findOrCreateTopics(topicNames);

    // Compute derived metrics using validated session duration from the plan
    const sessionDurationInHours = validatedData.sessionDurationInHours ?? 1.0;
    const totalSessions = planTotalSessions({
      sessionsPerWeek,
      durationInMonths,
    });
    const totalHours = totalSessions * sessionDurationInHours;
    const lateJoinRefusal = lateJoinCutoffRefusal(
      lateJoinUntilSession,
      totalSessions,
    );
    if (lateJoinRefusal) return lateJoinRefusal;

    // Calculate end date only if startDate is provided and valid
    let start: Date | undefined = startDate ? new Date(startDate) : undefined;
    let end: Date | undefined = undefined;
    if (start && !isNaN(start.getTime())) {
      // FIXED: Check if date is valid and handle month-end overflow
      end = new Date(start);
      // Ensure durationInMonths is valid before using
      if (typeof durationInMonths === "number" && durationInMonths > 0) {
        end = addMonths(start, durationInMonths);
      } else {
        // Handle invalid durationInMonths if necessary, maybe throw error or default
        console.warn("Invalid durationInMonths provided:", durationInMonths);
        end = undefined; // Or set default end date logic
      }
    } else {
      start = undefined; // Treat invalid start date string as undefined
    }
    const classStatus =
      status ?? (start ? ClassStatus.SCHEDULED : ClassStatus.DRAFT);

    // #784 — the session start times, computed once so the AE-2 co-host guard
    // and the appointment create below cannot drift apart.
    const sessionStarts: Date[] = start
      ? seriesStartsFrom(
          start,
          sessionsPerWeek,
          totalSessions,
          resolveSchedulingTimezone(consultantProfile.user.timezone),
        )
      : [];

    // A class given a start holds every session, each on the half-hour grid.
    const startRefusal = start ? eventTimeRefusal(start, "create") : null;
    if (startRefusal || (start && sessionStarts.length !== totalSessions)) {
      return NextResponse.json(
        {
          error:
            startRefusal?.message ??
            `That start can't place all ${totalSessions} sessions. Pick a different day or time.`,
          code: "EVENT_TIME_INVALID",
        },
        { status: 400 },
      );
    }

    // Create class plan, instance, and appointments in a transaction.
    // Serializable + retry: this writes N session slot atoms that the #440
    // exclusion constraint arbitrates, and it was the one crud-with-plan arm
    // still running at Read Committed while the webinar arm was not. The
    // callback touches `tx` only, so a P2034 replay re-runs nothing that
    // already committed on the outer client.
    // A scheduled class makes the host busy at every session: hold those atoms.
    const hostWindows =
      classStatus === ClassStatus.SCHEDULED
        ? sessionStarts.map((startsAt) => ({
            startsAt,
            endsAt: new Date(
              startsAt.getTime() + sessionDurationInHours * 60 * 60 * 1000,
            ),
          }))
        : [];
    const result = await withHostSlotBatch(
      hostBatchEntries([consultantProfileId], hostWindows),
      (renewHostBatch) =>
        withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              await renewHostBatch();
              // 1. Create the class plan using validated data
              const classPlan = await tx.classPlan.create({
                data: {
                  title,
                  description,
                  durationInMonths,
                  price,
                  priceCurrency,
                  maxParticipants,
                  refundWindowHours,
                  lateJoinUntilSession,
                  lateJoinersGetPastRecordings,
                  language,
                  level,
                  prerequisites,
                  materialProvided,
                  learningOutcomes,
                  subtitle,
                  targetAudience,
                  whatsIncluded,
                  faqs: faqCreateNested(faqs),
                  certificateProvided,
                  waitlistEnabled,
                  waitlistMax,
                  recordingEnabled,
                  sessionsPerWeek,
                  sessionDurationInHours,
                  totalSessions,
                  totalHours,
                  emailSupport,
                  consultantProfile: { connect: { id: consultantProfileId } },
                  topics: topicIds // Use validated topics here
                    ? { connect: topicIds.map((id: string) => ({ id })) }
                    : undefined,
                  classContents: curriculumCreateNested(classContents),
                },
                include: {
                  consultantProfile: PROFILE_OWNER_SELECT,
                  topics: true,
                  classContents: true,
                  faqs: { orderBy: { order: "asc" } },
                },
              });

              const sessionWindows = sessionStarts.map((startsAt) => ({
                startsAt,
                endsAt: new Date(
                  startsAt.getTime() + sessionDurationInHours * 60 * 60 * 1000,
                ),
              }));

              // AE-2 (#784) — mirrors the webinar PATCH: refuse to commit session
              // times an ACCEPTED co-host is already busy for. A plan created in
              // this very transaction has none, so this only bites once a plan can
              // carry collaborators before its sessions are laid down.
              await assertCollaboratorsAvailableForWindows(tx, {
                planType: "CLASS",
                planId: classPlan.id,
                windows: sessionWindows,
              });

              // #2010 — also verify the host consultant has no overlapping live
              // hold, co-host commitment, or confirmed session when publishing.
              if (
                classStatus === ClassStatus.SCHEDULED &&
                sessionWindows.length > 0
              ) {
                await assertConsultantAvailableForWindows(tx, {
                  consultantProfileId,
                  consultantUserId: session.user.id,
                  windows: sessionWindows,
                });
              }

              // 2. Create the class instance with appointments
              const classEvent = await tx.class.create({
                data: {
                  status: classStatus,
                  schedulingPeriodStartsAt: start, // Will be undefined if not provided
                  schedulingPeriodEndsAt: end, // Will be undefined if start is not provided
                  schedulingTimezone: resolveSchedulingTimezone(
                    consultantProfile.user.timezone,
                  ),
                  classPlan: { connect: { id: classPlan.id } },
                  // #1554 / #2010 — one wrapper with one occurrence per session;
                  // non-tentative when SCHEDULED so occurrence_no_confirmed_overlap
                  // enforces single-active-session across all offering types.
                  appointment:
                    sessionStarts.length > 0
                      ? {
                          create: {
                            appointmentType: "CLASS" as const,
                            occurrences: {
                              create: sessionStarts.map((slotStart, index) =>
                                buildOccurrence({
                                  startsAt: slotStart,
                                  durationInHours: sessionDurationInHours,
                                  consultantProfileId,
                                  isTentative:
                                    classStatus !== ClassStatus.SCHEDULED,
                                  ordinal: index + 1,
                                }),
                              ),
                            },
                          },
                        }
                      : undefined,
                },
                include: {
                  classPlan: {
                    include: {
                      consultantProfile: PROFILE_OWNER_SELECT,
                      topics: true,
                      classContents: true,
                    },
                  },
                  appointment: {
                    include: {
                      occurrences: true,
                    },
                  },
                },
              });

              // #1554 — the roster is AppointmentParticipant; the planner seats the
              // consultant on the wrapper exactly as the allocator does, or the
              // reconcile sweep reads every planner-scheduled class as drift.
              if (classEvent.appointment) {
                await recordParticipants(
                  tx,
                  classEvent.appointment.id,
                  [{ userId: session.user.id, role: "CONSULTANT" }],
                  { status: "CONFIRMED" },
                );
              }

              return { classPlan, classEvent };
            },
            {
              timeout: 25000,
              maxWait: 5000,
              isolationLevel: "Serializable",
            },
          ),
        ),
    );

    // Transform topics to strings in response
    const transformedEvent = transformNestedPlanTopics(
      result.classEvent,
      "classPlan",
    );
    return NextResponse.json({ data: transformedEvent }, { status: 201 });
  } catch (error) {
    // --- Zod Error Handling ---
    if (error instanceof z.ZodError) {
      console.error("Validation Error (POST Catch):", error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: error.issues },
        { status: 400 },
      );
    }
    // --- End Zod Error Handling ---

    // AE-2 (#784) — co-host clash is a conflict, not a server error.
    if (error instanceof CollaboratorUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Lock outcomes are structured answers, never a 500.
    if (
      error instanceof EventCheckoutBusyError ||
      error instanceof EventCheckoutLockUnavailableError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    // #2010 — host overlap against live hold / co-host commitment / session → 409.
    if (error instanceof ConsultantScheduleConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // #784 — the owner is denormalized onto group-event slots, so a scheduling
    // overlap trips occurrence_no_confirmed_overlap (23P01): a conflict, not a 500.
    if (isExclusionViolation(error)) {
      return NextResponse.json(
        {
          error:
            "That time conflicts with another confirmed session on your calendar.",
        },
        { status: 409 },
      );
    }

    console.error("Error creating class with plan:", error);
    // Add more detailed logging
    let errorMessage = "An error occurred while creating the class";
    let errorDetails = null;
    if (error instanceof Error) {
      errorMessage = error.message;
      // Log stack trace for more context if available
      console.error("Stack trace:", error.stack);
      // Capture Prisma-specific errors if possible (example)
      if ("code" in error && "meta" in error) {
        // Basic check for Prisma error structure
        errorDetails = { code: error.code, meta: error.meta };
        console.error("Prisma Error Code:", error.code);
        console.error("Prisma Error Meta:", error.meta);
      }
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: errorMessage, details: errorDetails }, // Return more details
      { status: 500 },
    );
  }
}

/**
 * Updates a ClassPlan and its associated Class instance, enforcing host and collaborator availability on schedule, publication, or owner changes.
 */
export async function PATCH(request: NextRequest) {
  try {
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await request.json();
    console.log(
      "Received class update request body:",
      JSON.stringify(body, null, 2),
    );

    // Grandfather legacy non-30-min session durations on unrelated PATCHes.
    // ClassPlanSchema now rejects non-aligned values, but the planner often
    // re-sends the full form — without this, editing title/price on a 0.75h
    // plan would 400 even though duration is unchanged (#1071 / PR #1091).
    if (
      typeof body?.id === "string" &&
      typeof body?.sessionDurationInHours === "number"
    ) {
      const existingDuration = await prisma.classPlan.findUnique({
        where: { id: body.id },
        select: { sessionDurationInHours: true },
      });
      if (
        existingDuration &&
        body.sessionDurationInHours === existingDuration.sessionDurationInHours
      ) {
        delete body.sessionDurationInHours;
      }
    }

    // --- Zod Validation ---
    const validationResult = PatchClassWithPlanBodySchema.safeParse(body);

    if (!validationResult.success) {
      console.error("Validation Error (PATCH):", validationResult.error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;
    // The editor only saves a draft or publishes; cancellation owns refunds.
    const status = editorStatusOrRefusal(validatedData.status, "class");
    if (status instanceof NextResponse) return status;
    const {
      id,
      classId,
      title,
      description,
      durationInMonths,
      price,
      priceCurrency,
      certificateProvided,
      waitlistEnabled,
      waitlistMax,
      sessionsPerWeek,
      emailSupport,
      maxParticipants,
      refundWindowHours,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      subtitle,
      targetAudience,
      whatsIncluded,
      faqs,
      consultantProfileId,
      topics: topicNames,
      classContents,
      startDate: startDateString,
      endDate: endDateString,
      recordingEnabled,
      sessionDurationInHours: patchSessionDuration,
      lateJoinUntilSession,
      lateJoinersGetPastRecordings,
    } = validatedData;

    // Find or create topics by name if provided
    let topicIds: string[] | undefined;
    if (topicNames !== undefined) {
      topicIds = await findOrCreateTopics(topicNames);
    }

    console.log("Validated fields for update:", {
      id,
      classId,
      title,
      status,
      topicIds,
    });

    // First, check if the class plan exists
    const existingPlan = await prisma.classPlan.findUnique({
      where: { id },
      include: {
        consultantProfile: PROFILE_OWNER_SELECT,
        topics: true,
        classContents: true,
        classes: true,
      },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: `Class plan with ID ${id} not found` },
        { status: 404 },
      );
    }

    // Verify ownership - user must own this class plan
    if (
      !existingPlan.consultantProfile ||
      existingPlan.consultantProfile.userId !== session.user.id
    ) {
      return NextResponse.json(
        { error: "You do not have permission to update this class" },
        { status: 403 },
      );
    }

    if (
      existingPlan.organizationId &&
      !(await isActiveOrgExpert(
        prisma,
        existingPlan.organizationId,
        existingPlan.consultantProfile.id,
      ))
    ) {
      return NextResponse.json(NOT_ACTIVE_ORG_EXPERT_REFUSAL, { status: 403 });
    }

    const reassignmentRefusal = await refuseForeignProfileReassignment(
      session.user.id,
      existingPlan.consultantProfileId,
      consultantProfileId,
    );
    if (reassignmentRefusal) return reassignmentRefusal;

    const lateJoinRefusal = lateJoinCutoffRefusal(
      lateJoinUntilSession,
      (sessionsPerWeek ?? existingPlan.sessionsPerWeek) *
        (durationInMonths ?? existingPlan.durationInMonths) *
        4,
    );
    if (lateJoinRefusal) return lateJoinRefusal;

    // A supplied classId must name an instance of this plan; otherwise use its first.
    const classToUpdate = classId
      ? await prisma.class.findFirst({
          where: { id: classId, classPlanId: id },
        })
      : existingPlan.classes.length > 0
        ? existingPlan.classes[0]
        : null;

    if (classId && !classToUpdate) {
      return NextResponse.json(
        { error: `Class ${classId} not found on plan ${id}` },
        { status: 404 },
      );
    }

    // Check if trying to update instance fields without an instance (still necessary)
    if (
      !classToUpdate &&
      (status !== undefined ||
        startDateString !== undefined ||
        endDateString !== undefined)
    ) {
      return NextResponse.json(
        { error: "Cannot update status or dates: no class instance found" },
        { status: 400 },
      );
    }

    // Update class plan and related data in a transaction. Serializable +
    // retry to match the POST arm; the callback touches `tx` only.
    // Host time this edit can make busy: the live sessions of a class being
    // published, moved or handed to another owner. Lock order: event → batch.
    const ownerForBatch =
      consultantProfileId ?? existingPlan.consultantProfileId;
    const touchesHostTime =
      status === "SCHEDULED" ||
      startDateString !== undefined ||
      endDateString !== undefined ||
      (consultantProfileId !== undefined &&
        consultantProfileId !== existingPlan.consultantProfileId);
    const batchWindows =
      classToUpdate && touchesHostTime
        ? await prisma.appointmentOccurrence.findMany({
            where: {
              appointment: { classId: classToUpdate.id, deletedAt: null },
              deletedAt: null,
            },
            select: { startsAt: true, endsAt: true },
          })
        : [];
    const batchProfiles =
      batchWindows.length > 0 && ownerForBatch
        ? [ownerForBatch, ...(await acceptedCohostProfileIds("CLASS", id))]
        : [];
    // Outside the retry, so a retried transaction re-stages the same notice keys.
    const seatOpenedAt = new Date();
    const result = await withEventCheckoutLock(
      classToUpdate
        ? { appointmentType: "CLASS", eventId: classToUpdate.id }
        : null,
      (renewEventLock) =>
        withHostSlotBatch(
          hostBatchEntries(batchProfiles, batchWindows),
          (renewHostBatch) =>
            withSerializableRetry(() =>
              prisma.$transaction(
                async (tx) => {
                  await renewEventLock();
                  await renewHostBatch();
                  // Use topics from existingPlan fetched *before* the transaction
                  const currentTopicIdsFromOuterScope = existingPlan.topics.map(
                    (t) => t.id,
                  );
                  console.log(
                    `[Before Transaction Update] Topics from initial fetch for class plan ${id}:`,
                    currentTopicIdsFromOuterScope,
                  );

                  // Handle class contents update logic (only if provided in validated data)
                  let classContentsUpdateData = {};
                  if (classContents && Array.isArray(classContents)) {
                    // Zod validation for contents already happened via main schema parse

                    // Delete existing class contents first
                    await tx.classContent.deleteMany({
                      where: { classPlanId: id },
                    });
                    // Prepare new class contents for creation
                    classContentsUpdateData = {
                      classContents: curriculumCreateNested(classContents),
                    };
                    console.log(
                      `Updating class contents for plan ${id}. Creating ${classContents.length} new entries.`,
                    );
                  } else {
                    console.log(
                      `No class contents provided for update on plan ${id}.`,
                    );
                  }

                  // Prepare the main update data, only including fields present in validatedData
                  const updateData: Prisma.ClassPlanUpdateInput = {};
                  if (title !== undefined) updateData.title = title;
                  if (description !== undefined)
                    updateData.description = description;
                  if (durationInMonths !== undefined)
                    updateData.durationInMonths = durationInMonths;
                  if (price !== undefined) updateData.price = price;
                  if (priceCurrency !== undefined)
                    updateData.priceCurrency = priceCurrency;
                  if (certificateProvided !== undefined)
                    updateData.certificateProvided = certificateProvided;
                  if (waitlistEnabled !== undefined)
                    updateData.waitlistEnabled = waitlistEnabled;
                  if (waitlistMax !== undefined)
                    updateData.waitlistMax = waitlistMax;
                  if (recordingEnabled !== undefined)
                    updateData.recordingEnabled = recordingEnabled;
                  if (sessionsPerWeek !== undefined)
                    updateData.sessionsPerWeek = sessionsPerWeek;
                  if (emailSupport !== undefined)
                    updateData.emailSupport = emailSupport;

                  // Allow updating sessionDurationInHours
                  if (patchSessionDuration !== undefined)
                    updateData.sessionDurationInHours = patchSessionDuration;

                  // Recompute derived metrics if base fields are being updated
                  if (
                    sessionsPerWeek !== undefined ||
                    durationInMonths !== undefined ||
                    patchSessionDuration !== undefined
                  ) {
                    const finalMeetingsPerWeek =
                      sessionsPerWeek ?? existingPlan.sessionsPerWeek;
                    const finalDurationInMonths =
                      durationInMonths ?? existingPlan.durationInMonths;
                    const finalSessionDurationInHours =
                      patchSessionDuration ??
                      existingPlan.sessionDurationInHours ??
                      1.0;

                    updateData.totalSessions = planTotalSessions({
                      sessionsPerWeek: finalMeetingsPerWeek,
                      durationInMonths: finalDurationInMonths,
                    });
                    updateData.totalHours =
                      updateData.totalSessions * finalSessionDurationInHours;
                  }
                  // The editor shows a batch's effective capacity, so an edit moves
                  // that batch's override; the plan's default moves only without one.
                  if (maxParticipants !== undefined && !classToUpdate)
                    updateData.maxParticipants = maxParticipants;
                  // #1780 row 2 — the window lives on the plan; seats snapshot it.
                  if (refundWindowHours !== undefined)
                    updateData.refundWindowHours = refundWindowHours;
                  // #1819 — the host's late-join settings; null resets to "until session 1".
                  if (lateJoinUntilSession !== undefined)
                    updateData.lateJoinUntilSession = lateJoinUntilSession;
                  if (lateJoinersGetPastRecordings !== undefined)
                    updateData.lateJoinersGetPastRecordings =
                      lateJoinersGetPastRecordings;
                  if (language !== undefined) updateData.language = language;
                  if (level !== undefined) updateData.level = level;
                  if (prerequisites !== undefined)
                    updateData.prerequisites = prerequisites; // handles null too
                  if (materialProvided !== undefined)
                    updateData.materialProvided = materialProvided; // handles null too
                  if (learningOutcomes !== undefined)
                    updateData.learningOutcomes = learningOutcomes;
                  if (subtitle !== undefined) updateData.subtitle = subtitle;
                  if (targetAudience !== undefined)
                    updateData.targetAudience = targetAudience;
                  if (whatsIncluded !== undefined)
                    updateData.whatsIncluded = whatsIncluded;
                  if (faqs !== undefined)
                    updateData.faqs = faqReplaceNested(faqs);
                  if (consultantProfileId !== undefined)
                    updateData.consultantProfile = {
                      connect: { id: consultantProfileId },
                    };

                  // Spread the contents update if any (only if classContents was in validatedData)
                  if (classContents !== undefined) {
                    Object.assign(updateData, classContentsUpdateData);
                  }

                  // Handle topics: topicIds are already validated/created by findOrCreateTopics
                  if (topicIds !== undefined) {
                    updateData.topics = {
                      set: topicIds.map((topicId: string) => ({ id: topicId })),
                    };
                    console.log(
                      `Syncing class topics with provided IDs: [${topicIds.join(", ")}]`,
                    );
                  } else {
                    console.log(
                      "Class topics is undefined in the request. Existing topics will not be modified.",
                    );
                  }

                  // Execute the plan update only if there's data to update
                  let updatedClassPlan = existingPlan; // Start with existing if no updates
                  // Check if updateData has keys, or if topics/contents were explicitly provided for update
                  if (
                    Object.keys(updateData).length > 0 ||
                    topicIds !== undefined ||
                    classContents !== undefined
                  ) {
                    updatedClassPlan = await tx.classPlan.update({
                      where: { id }, // Use validated id
                      data: updateData,
                      include: {
                        consultantProfile: PROFILE_OWNER_SELECT,
                        topics: true,
                        classContents: true,
                        classes: true, // Keep included to match existingPlan type
                      },
                    });
                  }

                  console.log("Updated class plan:", {
                    id: updatedClassPlan.id,
                    title: updatedClassPlan.title,
                    topicsCount: updatedClassPlan.topics.length,
                    contentsCount: updatedClassPlan.classContents.length,
                  });

                  // Switching the list off closes it silently, in this transaction.
                  if (waitlistEnabled === false) {
                    await expireEventWaitlistForPlan(tx, "CLASS", id);
                  }

                  // Update the class instance if it exists and relevant fields are provided
                  let updatedClass = classToUpdate;
                  let seatOpened: StagedSeatOpened | null = null;
                  let raisedOnAppointment: string | null = null;
                  if (updatedClass) {
                    // Prepare update data for the Class instance, handling optional validated fields
                    const classUpdateData: {
                      status?: ClassStatus;
                      schedulingPeriodStartsAt?: Date | null;
                      schedulingPeriodEndsAt?: Date | null;
                      maxParticipants?: number | null;
                    } = {};

                    // Publishing DRAFT -> SCHEDULED is the only status edge an edit may
                    // move; any other change matches zero rows and answers 409.
                    const publishing =
                      status === "SCHEDULED" && updatedClass.status === "DRAFT";
                    if (
                      status !== undefined &&
                      status !== updatedClass.status
                    ) {
                      await transitionClassEvent(tx, {
                        where: { id: updatedClass.id },
                        to: status,
                        fromIn: EVENT_PUBLISHABLE_FROM,
                      });
                    }

                    // #628 — shrinking below the students already enrolled would strand
                    // paying learners. Checked inside the tx (the old guard ran before
                    // it and left a TOCTOU window).
                    if (maxParticipants !== undefined) {
                      const classAppointment = await tx.appointment.findUnique({
                        where: { classId: updatedClass.id },
                        include: {
                          participants: {
                            where: seatHoldingParticipant(new Date()),
                            select: { userId: true },
                          },
                        },
                      });
                      const consultantUserId =
                        existingPlan.consultantProfile?.userId;
                      const enrolledCount = countWebinarParticipants(
                        classAppointment,
                        consultantUserId ? [consultantUserId] : [],
                      );
                      if (maxParticipants < enrolledCount) {
                        throw new CapacityBelowEnrollmentError(
                          capacityBelowRegisteredMessage(
                            maxParticipants,
                            enrolledCount,
                          ),
                        );
                      }
                      // An override equal to the plan's default is stored as null, so an
                      // untouched field never pins one; only a real raise frees a seat.
                      const override = capacityOverrideFor(
                        maxParticipants,
                        existingPlan,
                      );
                      if (override !== updatedClass.maxParticipants) {
                        classUpdateData.maxParticipants = override;
                      }
                      const priorCapacity = effectiveMaxParticipants(
                        updatedClass,
                        existingPlan,
                      );
                      if (
                        classAppointment &&
                        maxParticipants > priorCapacity &&
                        maxParticipants > enrolledCount
                      ) {
                        raisedOnAppointment = classAppointment.id;
                      }
                    }

                    // Handle startDate: update if provided, set to null if explicitly null, otherwise leave unchanged
                    // Need to parse the string date from validated data
                    if (startDateString !== undefined) {
                      classUpdateData.schedulingPeriodStartsAt = startDateString
                        ? new Date(startDateString)
                        : null;
                      // Optional: Add check for valid date parsing: !isNaN(classUpdateData.schedulingPeriodStartsAt?.getTime())
                      if (
                        classUpdateData.schedulingPeriodStartsAt &&
                        Number.isNaN(
                          classUpdateData.schedulingPeriodStartsAt.getTime(),
                        )
                      ) {
                        console.warn(
                          "Invalid startDate received in PATCH:",
                          startDateString,
                        );
                        // Decide how to handle: throw error, ignore, set null?
                        // For now, let's ignore the invalid date update for startDate
                        delete classUpdateData.schedulingPeriodStartsAt;
                      }
                    }

                    // Handle endDate: update if provided, set to null if explicitly null, otherwise leave unchanged
                    if (endDateString !== undefined) {
                      classUpdateData.schedulingPeriodEndsAt = endDateString
                        ? new Date(endDateString)
                        : null;
                      // Optional: Add check for valid date parsing
                      if (
                        classUpdateData.schedulingPeriodEndsAt &&
                        isNaN(classUpdateData.schedulingPeriodEndsAt.getTime())
                      ) {
                        console.warn(
                          "Invalid endDate received in PATCH:",
                          endDateString,
                        );
                        // Ignore invalid date update for endDate
                        delete classUpdateData.schedulingPeriodEndsAt;
                      }
                    }

                    // #627 — a class with enrolled, paying learners may not have its
                    // scheduling period moved here; the reschedule workflow is the front
                    // door. Read INSIDE the txn: the pre-txn version counted payments and
                    // then committed the move, so an enrolment landing in between moved
                    // the schedule under a learner who had just paid.
                    //
                    // Compared at DAY granularity, and only for a value actually sent:
                    // the planner client re-sends startDate/endDate even for a
                    // title-only edit.
                    const liveClass = await tx.class.findUnique({
                      where: { id: updatedClass.id },
                      select: {
                        schedulingPeriodStartsAt: true,
                        schedulingPeriodEndsAt: true,
                      },
                    });
                    const dayKey = (d: Date | null | undefined) =>
                      d?.toISOString()?.slice(0, 10);
                    const startChanged =
                      startDateString !== undefined &&
                      startDateString !== null &&
                      dayKey(liveClass?.schedulingPeriodStartsAt) !==
                        dayKey(new Date(startDateString));
                    const endChanged =
                      endDateString !== undefined &&
                      endDateString !== null &&
                      dayKey(liveClass?.schedulingPeriodEndsAt) !==
                        dayKey(new Date(endDateString));
                    const periodMoved = startChanged || endChanged;

                    if (periodMoved) {
                      const activePayments = await tx.payment.count({
                        where: {
                          appointment: { classId: updatedClass.id },
                          paymentStatus: { notIn: ["FAILED", "EXPIRED"] },
                        },
                      });
                      if (activePayments > 0) {
                        throw new ScheduleLockedError(
                          CLASS_SCHEDULE_LOCKED_MESSAGE,
                        );
                      }
                    }

                    const effectiveClassStatus = status ?? updatedClass.status;
                    const ownerProfileId =
                      consultantProfileId ??
                      updatedClassPlan.consultantProfile?.id ??
                      existingPlan.consultantProfile?.id;
                    let ownerUserId: string | undefined;
                    if (
                      updatedClassPlan.consultantProfile?.id === ownerProfileId
                    ) {
                      ownerUserId = updatedClassPlan.consultantProfile?.userId;
                    } else if (
                      existingPlan.consultantProfile?.id === ownerProfileId
                    ) {
                      ownerUserId = existingPlan.consultantProfile?.userId;
                    }
                    const ownerChanged = Boolean(
                      consultantProfileId &&
                      consultantProfileId !== existingPlan.consultantProfileId,
                    );

                    // AE-2 (#784) / #2010 — mirrors the webinar PATCH's guard at its
                    // own time commit: when this PATCH moves the scheduling period,
                    // publishes a DRAFT class to SCHEDULED, or transfers the plan to a
                    // new consultant, the sessions it leaves standing must be free for
                    // every ACCEPTED co-host and for the target host consultant.
                    if (
                      periodMoved ||
                      publishing ||
                      (ownerChanged && effectiveClassStatus === "SCHEDULED")
                    ) {
                      const liveSessions = await tx.appointment.findMany({
                        where: { classId: updatedClass.id, deletedAt: null },
                        select: {
                          id: true,
                          occurrences: {
                            where: { deletedAt: null },
                            select: { startsAt: true, endsAt: true },
                          },
                        },
                      });
                      const windows = liveSessions.flatMap(
                        (a) => a.occurrences,
                      );
                      const excludeAppointmentIds = liveSessions.map(
                        (a) => a.id,
                      );
                      if (periodMoved || publishing) {
                        await assertCollaboratorsAvailableForWindows(tx, {
                          planType: "CLASS",
                          planId: id,
                          windows,
                          excludeAppointmentIds,
                        });
                      }
                      if (
                        effectiveClassStatus === "SCHEDULED" &&
                        ownerProfileId &&
                        windows.length > 0
                      ) {
                        await assertConsultantAvailableForWindows(tx, {
                          consultantProfileId: ownerProfileId,
                          consultantUserId: ownerUserId,
                          windows,
                          excludeAppointmentIds,
                        });
                      }
                    }

                    if (publishing || (ownerChanged && ownerProfileId)) {
                      await tx.appointmentOccurrence.updateMany({
                        where: {
                          appointment: { classId: updatedClass.id },
                          deletedAt: null,
                        },
                        data: {
                          ...(publishing ? { isTentative: false } : {}),
                          ...(ownerChanged && ownerProfileId
                            ? { consultantProfileId: ownerProfileId }
                            : {}),
                        },
                      });
                    }

                    if (Object.keys(classUpdateData).length > 0) {
                      updatedClass = await tx.class.update({
                        where: { id: updatedClass.id },
                        data: classUpdateData,
                        include: {
                          classPlan: {
                            include: {
                              consultantProfile: PROFILE_OWNER_SELECT,
                              topics: true,
                              classContents: true,
                            },
                          },
                          appointment: {
                            include: {
                              occurrences: true,
                            },
                          },
                        },
                      });
                    } else {
                      // No field updates (or only the status moved above): fetch it
                      // with all its relations so the response reflects the current row.
                      updatedClass = await tx.class.findUnique({
                        where: { id: updatedClass.id },
                        include: {
                          classPlan: {
                            include: {
                              consultantProfile: PROFILE_OWNER_SELECT,
                              topics: true,
                              classContents: true,
                            },
                          },
                          appointment: {
                            include: {
                              occurrences: true,
                            },
                          },
                        },
                      });
                    }
                    // The notice guards decide whether the new capacity frees anything.
                    if (raisedOnAppointment) {
                      seatOpened = await stageSeatOpenedNotices(
                        tx,
                        raisedOnAppointment,
                        seatOpenedAt,
                      );
                    }
                  }

                  // Return the results
                  return {
                    classPlan: updatedClassPlan,
                    class: updatedClass,
                    seatOpened,
                  };
                },
                {
                  timeout: 10000, // 10 second timeout
                  maxWait: 5000, // 5 second max wait
                  isolationLevel: "Serializable", // Highest isolation level
                },
              ),
            ),
        ),
    );

    console.log(
      "Update transaction completed successfully. Returning updated class data.",
    );
    await scheduleAfter(
      () => finishSeatOpenedNotices(result.seatOpened),
      "class-update.seat-opened",
    );

    // Return the appropriate response based on whether we had a class instance
    // Transform topics to strings in response
    let responseData;
    if (result.class) {
      responseData = transformNestedPlanTopics(result.class, "classPlan");
    } else {
      responseData = {
        ...result.classPlan,
        topics: result.classPlan.topics.map((t) => t.name),
      };
    }

    return NextResponse.json({ data: responseData }, { status: 200 });
  } catch (error) {
    // --- Zod Error Handling ---
    if (error instanceof z.ZodError) {
      console.error("Validation Error (PATCH Catch):", error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: error.issues },
        { status: 400 },
      );
    }
    // --- End Zod Error Handling ---

    // Shrinking below the current roster is a user error, not a 500.
    if (error instanceof CapacityBelowEnrollmentError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // #627 — a frozen schedule on an enrolled class is a user error, not a 500.
    if (error instanceof ScheduleLockedError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // AE-2 (#784) — co-host clash is a conflict, not a server error.
    if (error instanceof CollaboratorUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Lock outcomes are structured answers, never a 500.
    if (
      error instanceof EventCheckoutBusyError ||
      error instanceof EventCheckoutLockUnavailableError ||
      error instanceof BookingLockUnavailableError
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    // #2010 — host overlap against live hold / co-host commitment / session → 409.
    if (error instanceof ConsultantScheduleConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // #784 — owner overlap on the shared exclusion constraint → 409, not 500.
    if (isExclusionViolation(error)) {
      return NextResponse.json(
        {
          error:
            "That time conflicts with another confirmed session on your calendar.",
        },
        { status: 409 },
      );
    }

    console.error("Error updating class with plan:", error);

    // If error indicates topics don't exist (keep specific error handling)
    if (
      error instanceof Error &&
      error.message.includes("The following topic IDs do not exist:") // More specific check
    ) {
      return NextResponse.json(
        { error: `Invalid topics provided: ${error.message}` },
        { status: 400 },
      );
    }
    if (
      error instanceof Error &&
      error.message === "Invalid data provided for class contents." // Catch specific content error
    ) {
      return NextResponse.json(
        { error: "Invalid class contents provided." },
        { status: 400 },
      );
    }

    // #1319 — an illegal status move (stale tab, cancelled class) is a 409.
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating the class" },
      { status: 500 },
    );
  }
}
