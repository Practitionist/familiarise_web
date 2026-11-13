/**
 * Subscription Slot Validation API Route
 *
 * Refactored to use unified ScheduleValidationService + SubscriptionValidationService
 * Reduced from 240 lines to ~100 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. ScheduleValidationService - Validates business rules (conflicts, availability, etc.)
 * 3. SubscriptionValidationService - Validates subscription-specific rules (cycle window and cap, plan total)
 */

import { readJsonBody } from "@/lib/api/parse";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import { SubscriptionValidationService } from "@/utils/subscriptionValidation";
import {
  soldSessionMinutes,
  soldSessionsPerWeek,
} from "@/lib/booking/entitlement";
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
  findTentativeOccurrenceIdsForEvent,
} from "@/lib/booking/validate-conflict-view";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

interface ValidationResult extends SlotConflictResult {
  subscriptionValidation?: Awaited<
    ReturnType<SubscriptionValidationService["validateSubscriptionSlots"]>
  >;
}

const subscriptionInclude = {
  subscriptionPlan: {
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
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    const { subscriptionId } = await params;

    // Id shape before the authz read: no lookup on an arbitrary string.
    const malformed = refuseMalformedEventId(subscriptionId);
    if (malformed) return malformed;

    const authzError = await authorizeEventAccess(
      authResult.session,
      "subscription",
      subscriptionId,
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
      // Validate subscription ID from URL params
      eventIdSchema.parse(subscriptionId);

      // Validate request body and get typed data
      const read = await readJsonBody(request);
      if (read.error) return read.error;
      const body = validationRequestSchema.parse(read.body);

      // Fetch subscription with necessary relations
      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: subscriptionInclude,
      });

      if (!subscription) {
        return NextResponse.json(
          { error: "Subscription not found" },
          { status: 404 },
        );
      }

      const { subscriptionPlan } = subscription;
      const { consultantProfile } = subscriptionPlan;

      if (!consultantProfile) {
        return NextResponse.json(
          { error: "Consultant profile not found" },
          { status: 400 },
        );
      }

      // Convert slots to Date objects
      const slotDates = body.slots.map((slot) => new Date(slot));

      // Exclude this subscription's own tentative occurrences (initial request
      // holds or released reschedule occurrences) so they are not reported as
      // conflicts or double-counted against weekly/total limits.
      const excludeOccurrenceIds = await findTentativeOccurrenceIdsForEvent(
        prisma,
        { subscriptionId },
      );
      const consulteeUserId = subscription.requestedBy?.user?.id;

      // Subscription rules (the current cycle's window and cap, the plan total);
      // the cycle window is also the period the business validation clamps to.
      const subscriptionValidationService = new SubscriptionValidationService(
        prisma,
      );
      const subscriptionValidation =
        await subscriptionValidationService.validateSubscriptionSlots(
          subscriptionId,
          body.slots,
          [],
          excludeOccurrenceIds,
        );

      // LAYER 2: Business Logic Validation (conflicts, availability, consecutive slots, etc.)
      const validationService = new ScheduleValidationService(prisma);
      const validationResult = await validationService.validate(
        "subscription",
        subscriptionId,
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
          durationInMonths: subscriptionPlan.durationInMonths,
          // The terms frozen at purchase, not today's plan row.
          sessionsPerWeek: soldSessionsPerWeek(subscription),
          sessionDurationInHours: soldSessionMinutes(subscription) / 60,
          schedulingPeriodStartsAt:
            subscriptionValidation.subscriptionPeriod.start,
          schedulingPeriodEndsAt: subscriptionValidation.subscriptionPeriod.end,
          schedulingTimezone: subscription.schedulingTimezone,
        },
        [],
        {
          consulteeUserId,
          excludeOccurrenceIds,
          consultantProfileId: subscriptionPlan.consultantProfileId,
        },
      );
      const viewer = {
        userId: authResult.session.user.id,
        isEventConsultant:
          authResult.session.user.id === consultantProfile.user.id,
      };
      const conflictDetails = conflictDetailsBySlot(validationResult.conflicts);

      const categorized = validationResult.isValid
        ? {
            conflicts: [],
            outsideAvailability: [],
            tooSoon: [],
            validSlots: body.slots,
          }
        : categorizeValidationErrors({
            errors: validationResult.errors,
            slots: body.slots,
            conflictDetails,
            viewer,
            resolveFallbackType: (message) =>
              message.includes("subscription")
                ? "Subscription"
                : "Consultation",
          });

      const result: ValidationResult = {
        conflicts: categorized.conflicts,
        outsideAvailability: categorized.outsideAvailability,
        tooSoon: categorized.tooSoon,
        validSlots: subscriptionValidation.isValid
          ? categorized.validSlots
          : [],
        subscriptionValidation,
      };

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
    console.error("Validation error:", error);
    return NextResponse.json(
      {
        error: "Couldn't check these times. Try again in a moment.",
        errorCode: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
