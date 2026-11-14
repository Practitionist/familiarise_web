/**
 * Class Slot Validation API Route
 *
 * Refactored to use unified ScheduleValidationService
 * Reduced from 304 lines to ~110 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. ScheduleValidationService - Validates business rules (conflicts, availability, per-day cap, etc.)
 */

import { readJsonBody } from "@/lib/api/parse";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import {
  validationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { ZodError } from "zod";
import { requireApiAuth, authorizeEventAccess } from "@/lib/auth-helpers";
import { refuseMalformedEventId } from "@/lib/booking/request-route-guards";
import {
  categorizeValidationErrors,
  conflictDetailsBySlot,
  findTentativeOccurrenceIdsForEvent,
} from "@/lib/booking/validate-conflict-view";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

const classInclude = {
  classPlan: {
    include: {
      consultantProfile: {
        select: {
          user: { select: { id: true, timezone: true } },
          scheduleType: true,
          availabilityWindowsWeekly: true,
          availabilityWindowsCustom: true,
        },
      },
    },
  },
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    const { classId } = await params;

    const malformed = refuseMalformedEventId(classId);
    if (malformed) return malformed;

    const authzError = await authorizeEventAccess(
      authResult.session,
      "class",
      classId,
      request.method,
    );
    if (authzError) return authzError;

    // #831 — event mutations previously had no limiter
    const rl = await applyRateLimit(
      eventMutationLimiter,
      authResult.session.user.id,
    );
    if (rl) return rl;

    // LAYER 1: Zod Schema Validation (type-safe, automatic type inference)
    try {
      // Validate class ID from URL params
      eventIdSchema.parse(classId);

      // Validate request body and get typed data
      const read = await readJsonBody(request);
      if (read.error) return read.error;
      const body = validationRequestSchema.parse(read.body);

      // Fetch class with necessary relations
      const classEntity = await prisma.class.findUnique({
        where: { id: classId },
        include: classInclude,
      });

      if (!classEntity) {
        return NextResponse.json({ error: "Class not found" }, { status: 404 });
      }

      const { classPlan } = classEntity;
      const { consultantProfile } = classPlan;

      if (!consultantProfile) {
        return NextResponse.json(
          { error: "Consultant profile not found" },
          { status: 400 },
        );
      }

      // Convert slots to Date objects
      const slotDates = body.slots.map((slot) => new Date(slot));

      // Exclude this class's own tentative occurrences during re-allocation
      const excludeOccurrenceIds = await findTentativeOccurrenceIdsForEvent(
        prisma,
        { classId },
      );

      // LAYER 2: Business Logic Validation (conflicts, availability, consecutive slots, per-day cap, etc.)
      const validationService = new ScheduleValidationService(prisma);
      const validationResult = await validationService.validate(
        "class",
        classId,
        slotDates,
        {
          userId: consultantProfile.user.id,
          scheduleType: consultantProfile.scheduleType,
          availabilityWindowsWeekly:
            consultantProfile.availabilityWindowsWeekly,
          availabilityWindowsCustom:
            consultantProfile.availabilityWindowsCustom,
          timezone: consultantProfile.user.timezone || undefined,
        },
        {
          durationInMonths: classPlan.durationInMonths || 1,
          sessionsPerWeek: classPlan.sessionsPerWeek || 2,
          sessionDurationInHours: classPlan.sessionDurationInHours || 1,
          schedulingPeriodStartsAt:
            classEntity.schedulingPeriodStartsAt ?? undefined,
          schedulingPeriodEndsAt:
            classEntity.schedulingPeriodEndsAt ?? undefined,
          schedulingTimezone: classEntity.schedulingTimezone,
        },
        [],
        {
          excludeOccurrenceIds,
          consultantProfileId: classPlan.consultantProfileId ?? undefined,
        },
      );
      const viewer = {
        userId: authResult.session.user.id,
        isEventConsultant:
          authResult.session.user.id === consultantProfile.user.id,
      };
      const conflictDetails = conflictDetailsBySlot(validationResult.conflicts);

      // If validation passed, all slots are valid
      if (validationResult.isValid) {
        return NextResponse.json({
          data: {
            conflicts: [],
            outsideAvailability: [],
            validSlots: body.slots,
          },
        });
      }

      const result = categorizeValidationErrors({
        errors: validationResult.errors,
        slots: body.slots,
        conflictDetails,
        viewer,
        resolveFallbackType: (message) =>
          message.includes("subscription")
            ? "Subscription"
            : message.includes("class")
              ? "Class"
              : "Consultation",
      });

      return NextResponse.json({ data: result });
    } catch (validationError) {
      // Zod validation errors - return 400 Bad Request
      // The issue paths are developer detail: logged, never the user copy.
      if (validationError instanceof ZodError) {
        console.error(
          "Validation request refused:",
          JSON.stringify(validationError.errors),
        );
        return NextResponse.json(
          {
            error:
              "This request couldn't be read. Reload the page and try again.",
            errorCode: "VALIDATION_ERROR",
          },
          { status: 400 },
        );
      }
      throw validationError; // Re-throw non-validation errors
    }
  } catch (error) {
    // Catch-all for unexpected errors (database errors, network issues, etc.)
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Class validation error:", error);
    return NextResponse.json(
      {
        error: "Couldn't check these times. Try again in a moment.",
        errorCode: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
