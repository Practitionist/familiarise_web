/**
 * Consultation Slot Validation API Route
 *
 * Refactored to use unified ScheduleValidationService
 * Reduced from 200 lines to ~90 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. ScheduleValidationService - Validates business rules (conflicts, availability, etc.)
 */

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import {
  validationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { refuseMalformedEventId } from "@/lib/booking/request-route-guards";
import { ZodError } from "zod";
import type { SlotConflictResult } from "@/utils/scheduling-engine/types";
import { requireApiAuth, authorizeEventAccess } from "@/lib/auth-helpers";
import {
  categorizeValidationErrors,
  conflictDetailsBySlot,
} from "@/lib/booking/validate-conflict-view";
import { leadMsFor } from "@/lib/booking/lead-time";
import { SETTLED_CONSULTATION } from "@/lib/booking/approve-request";
import { bookedSessionMinutes } from "@/lib/appointments/occurrences";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

const consultationInclude = {
  consultationPlan: {
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
  requestedBy: {
    include: {
      user: { select: { id: true } },
    },
  },
  // The booked session carries the length the 1:1 was sold at.
  appointment: {
    select: {
      occurrences: {
        select: {
          startsAt: true,
          endsAt: true,
          completionStatus: true,
          deletedAt: true,
        },
      },
    },
  },
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    const { consultationId } = await params;

    // Id shape before the authz read: no lookup on an arbitrary string.
    const malformed = refuseMalformedEventId(consultationId);
    if (malformed) return malformed;

    const authzError = await authorizeEventAccess(
      authResult.session,
      "consultation",
      consultationId,
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
      // Validate consultation ID from URL params
      eventIdSchema.parse(consultationId);

      // Validate request body and get typed data
      const body = validationRequestSchema.parse(await request.json());

      // Fetch consultation with necessary relations
      const consultation = await prisma.consultation.findUnique({
        where: { id: consultationId },
        include: consultationInclude,
      });

      if (!consultation) {
        return NextResponse.json(
          { error: "Consultation not found" },
          { status: 404 },
        );
      }

      const { consultationPlan, requestedBy: _requestedBy } = consultation;
      const { consultantProfile } = consultationPlan;

      if (!consultantProfile) {
        return NextResponse.json(
          { error: "Consultant profile not found" },
          { status: 400 },
        );
      }

      // Convert slots to Date objects
      const slotDates = body.slots.map((slot) => new Date(slot));

      // LAYER 2: Business Logic Validation (conflicts, availability, consecutive slots, etc.)
      const validationService = new ScheduleValidationService(prisma);

      // Exclude this consultation's own tentative appointments from conflict
      // detection. During re-allocation (e.g. "Use Requested Times"), the old
      // tentative slots still exist and would otherwise be reported as conflicts.
      const tentativeAppointments = await prisma.appointment.findMany({
        where: {
          consultationId,
          occurrences: { some: { isTentative: true } },
        },
        select: { id: true },
      });
      const excludeIds = tentativeAppointments.map((a) => a.id);

      // The allocator counts the CONSULTEE's bookings with any consultant as
      // conflicts, so a preflight that omitted them reported "no conflicts" for
      // times the very next call would reject. The dialog renders its verdict
      // from this response, so the omission made that verdict unsound.
      const consulteeUserId =
        consultation.requestedBy?.user?.id ??
        (
          await prisma.consultation.findUnique({
            where: { id: consultationId },
            select: {
              requestedBy: { select: { user: { select: { id: true } } } },
            },
          })
        )?.requestedBy?.user?.id;

      const validationResult = await validationService.validate(
        "consultation",
        consultationId,
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
          durationInHours:
            (bookedSessionMinutes(
              consultation.appointment?.occurrences ?? [],
            ) ?? consultationPlan.durationInHours * 60) / 60,
        },
        excludeIds,
        {
          consulteeUserId,
          consultantProfileId: consultationPlan.consultantProfileId,
          // The same lead time the allocator applies: 2 h while unpaid.
          leadTimeMs: leadMsFor("allocate", {
            settled:
              (await prisma.consultation.count({
                where: { id: consultationId, ...SETTLED_CONSULTATION },
              })) > 0,
          }),
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

      const result: SlotConflictResult = categorizeValidationErrors({
        errors: validationResult.errors,
        slots: body.slots,
        conflictDetails,
        viewer,
        resolveFallbackType: (message) =>
          message.includes("subscription") ? "Subscription" : "Consultation",
      });

      return NextResponse.json({ data: result });
    } catch (validationError) {
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
    console.error("Validation error:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      {
        error: "Couldn't check these times. Try again in a moment.",
        errorCode: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
