/**
 * The one allocate handler behind the four PATCH routes
 * (`/api/bookings/{consultations,subscriptions,webinars,classes}/[id]/allocate`).
 * Each route resolves its own typed segment param and delegates here, so the
 * auth → limiter → Zod → SchedulingService → typed-error contract is written
 * once and every event type answers the same shape.
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. SchedulingService - Validates business rules and executes allocation
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { SchedulingService } from "@/utils/scheduling-engine/SchedulingService";
import type {
  AllocationMode,
  EventType,
} from "@/utils/scheduling-engine/types";
import {
  allocationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { refuseMalformedEventId } from "@/lib/booking/request-route-guards";
import {
  requireApiAuth,
  authorizeEventAccess,
  isEventConsultant,
} from "@/lib/auth-helpers";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  approvalMintConflict,
  mintApprovalPaymentAfterCommit,
} from "@/lib/booking/approve-request";
import { recordSystemError } from "@/lib/enterprise/system-events";

const LOG_LABEL: Record<EventType, string> = {
  consultation: "[Consultation Allocation]",
  subscription: "[Subscription Allocation]",
  webinar: "[Webinar Allocation]",
  class: "[Class Allocation]",
};

function resolveMode(body: {
  useRequestedSlots?: boolean;
  isAuto?: boolean;
}): AllocationMode {
  if (body.useRequestedSlots) return "requested";
  if (body.isAuto) return "auto";
  return "manual";
}

export async function handleAllocate(
  request: NextRequest,
  eventType: EventType,
  eventId: string,
): Promise<NextResponse> {
  const label = LOG_LABEL[eventType];
  const startTime = Date.now();
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    // Id shape before the authz read: no lookup on an arbitrary string.
    const malformed = refuseMalformedEventId(eventId);
    if (malformed) return malformed;

    // Verify caller is a participant (consultant or consultee) or ADMIN/STAFF
    const authzError = await authorizeEventAccess(
      authResult.session,
      eventType,
      eventId,
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
      eventIdSchema.parse(eventId);
      console.log(`${label} Starting allocation for ${eventType}: ${eventId}`);

      const body = allocationRequestSchema.parse(await request.json());
      const mode = resolveMode(body);
      console.log(
        `${label} Mode: ${mode}, Slots: ${body.slots ? body.slots.length : "auto"}`,
      );

      const canOverride = await isEventConsultant(
        authResult.session,
        eventType,
        eventId,
      );

      // LAYER 2: Business Logic Validation & Allocation
      const result = await SchedulingService.allocate({
        eventType,
        eventId,
        mode,
        slots: body.slots,
        // #837 — client dedupe key; a double-submit with the same value returns
        // the first batch instead of allocating twice.
        idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
        initialAllocation: body.initialAllocation,
        expectedTentativeSlotCount: body.expectedTentativeSlotCount,
        // Honoured only for the consultant (or ADMIN/STAFF): accepting a
        // time outside the published availability is the consultant's call,
        // not something a consultee may assert about someone else's schedule.
        override: body.override === true && canOverride,
        // #1206 — only the consultant (or a privileged caller) may decide to
        // schedule fewer sessions than the plan sold.
        allowPartial: body.allowPartial === true && canOverride,
        // #1206 — top up the sessions an earlier partial allocation left
        // unplaced instead of deleting the confirmed ones and re-planning.
        topUp: body.topUp === true && canOverride,
      });

      const duration = Date.now() - startTime;
      if (!result.success) {
        console.error(`${label} Failed after ${duration}ms: ${result.error}`);
        return NextResponse.json(
          {
            error: result.error,
            // Allocation-resilience audit gap #5 — the client needs the
            // structured code to render a cause-specific toast instead of
            // guessing from the raw message string.
            errorCode: result.errorCode,
            // #1206 — a SLOT_SHORTAGE the consultant could still act on: the
            // client offers "allocate N now, the rest later" instead of a
            // dead end.
            placeableSessions: result.placeableSessions,
            requiredSessions: result.requiredSessions,
            details: {
              eventType,
              eventId,
              mode,
              slotsProvided: body.slots ? body.slots.length : 0,
              duration,
            },
          },
          { status: result.httpStatus ?? 500 },
        );
      }

      console.log(
        `${label} Success after ${duration}ms. Created ${result.appointments?.length || 0} appointment(s)`,
      );
      if (result.warnings && result.warnings.length > 0) {
        console.warn(`${label} Warnings: ${result.warnings.join("; ")}`);
      }

      // #1775 B-9 — an unpaid request landed in APPROVED_PENDING_PAYMENT:
      // mint its pay order now, before the response, so the row carries the
      // link the client is about to read (`after()` is best-effort). A mint
      // that fails leaves the request awaiting payment with no link — the
      // same state the detail PATCH leaves — recorded as a system error;
      // re-approving reuses the same PENDING intent (#1181).
      const awaitingPayment = result.outcome === "awaiting_payment";
      if (
        awaitingPayment &&
        (eventType === "consultation" || eventType === "subscription")
      ) {
        const mint = await mintApprovalPaymentAfterCommit({
          kind: eventType,
          id: eventId,
        });
        // #1775 C-1 — a failed mint is a typed answer, never a 200 the client
        // reads as "sent": the request stays awaiting payment, retry reuses it.
        if (mint.status === "lapsed") {
          return NextResponse.json(
            { error: mint.message, errorCode: "ILLEGAL_TRANSITION" },
            { status: 409 },
          );
        }
        const conflict =
          mint.status === "mint_failed"
            ? approvalMintConflict(mint.error)
            : null;
        if (conflict) {
          return NextResponse.json(
            { error: conflict.message, errorCode: conflict.code },
            { status: 409 },
          );
        }
        if (mint.status === "mint_failed") {
          await recordSystemError({
            organizationId: null,
            category: "PAYMENT",
            summary:
              "Approval pay-link mint failed after allocation — approve again to retry",
            err: mint.error,
            context: { eventType, eventId },
          }).catch(() => {});
          return NextResponse.json(
            {
              error:
                "The times were saved, but generating the payment link failed. Approve again to retry the link.",
              errorCode: "PAYMENT_LINK_FAILED",
              awaitingPayment,
            },
            { status: 502 },
          );
        }
      }

      return NextResponse.json({
        data: result.appointments,
        warnings: result.warnings,
        // #1775 B-9 — the client says "the client has 24 h to pay", not
        // "Confirmed", when the approval is waiting on the pay order.
        awaitingPayment,
        // #1206 — derived, never stored: how much of the plan now has times.
        partial: result.partial,
        placedSessions: result.placedSessions,
        requiredSessions: result.requiredSessions,
        unplacedSessions: result.unplacedSessions,
        // #1206 — a top-up that wrote nothing. Lets the caller tell "already
        // complete / still no room" from "sessions were added".
        noChange: result.noChange,
      });
    } catch (validationError) {
      const duration = Date.now() - startTime;
      // Zod validation errors - return 400 Bad Request
      if (validationError instanceof ZodError) {
        const errorMessage = validationError.errors
          .map((err) => `${err.path.join(".")}: ${err.message}`)
          .join("; ");
        console.error(
          `${label} Validation failed after ${duration}ms:`,
          JSON.stringify(validationError.errors, null, 2),
        );
        return NextResponse.json(
          { error: errorMessage, details: validationError.errors, eventId },
          { status: 400 },
        );
      }
      throw validationError; // Re-throw non-validation errors
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    // Catch-all for unexpected errors (database errors, network issues, etc.)
    console.error(`${label} Error after ${duration}ms:`, error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      {
        // Never forward error.message: pool timeouts, connection errors,
        // and constraint text are operator detail, not user copy. The raw
        // error is already in Sentry + the server log above. Indeterminate
        // wording on purpose: a 500 can fire before or after the commit.
        error:
          "Couldn't save these times — check whether they appear, then retry.",
        errorCode: "UNKNOWN_ERROR",
        duration,
      },
      { status: 500 },
    );
  }
}
