/**
 * The one allocate handler behind the four PATCH routes
 * (`/api/bookings/{consultations,subscriptions,webinars,classes}/[id]/allocate`).
 * Each route resolves its own typed segment param and delegates here, so the
 * auth → limiter → Zod → allocate() → typed-error contract is written
 * once and every event type answers the same shape.
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. allocate() (lib/booking/allocation) - Validates business rules and executes allocation
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { allocate } from "@/lib/booking/allocation";
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
  resolveEventHostActor,
  resolveHostOrgMembership,
} from "@/lib/auth-helpers";
import type { Tx } from "@/lib/prisma";
import { recordOpsAction } from "@/lib/backoffice/ops-action-log";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  approvalMintConflict,
  mintApprovalPaymentAfterCommit,
} from "@/lib/booking/approve-request";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";

const LOG_LABEL: Record<EventType, string> = {
  consultation: "[Consultation Allocation]",
  subscription: "[Subscription Allocation]",
  webinar: "[Webinar Allocation]",
  class: "[Class Allocation]",
};

/**
 * The operator row for an allocation made by staff or a host-org operator,
 * written in the allocation's transaction; the plan's own consultant needs none.
 */
async function operatorAuditFor(
  user: { id: string; role?: string | null },
  hostActor: "staff" | "consultant" | "host-org",
  eventType: EventType,
  eventId: string,
  mode: AllocationMode,
): Promise<((tx: Tx) => Promise<void>) | undefined> {
  if (hostActor === "staff") {
    return async (tx) => {
      await recordOpsAction(tx, {
        actorUserId: user.id,
        actorRole: String(user.role ?? "UNKNOWN"),
        surface: "appointments.manage",
        action: "booking.allocate",
        targetKind: eventType,
        targetId: eventId,
        reason: "Set the booking's times",
        after: { mode },
      });
    };
  }
  if (hostActor !== "host-org") return undefined;
  const member = await resolveHostOrgMembership(user.id, eventType, eventId);
  if (!member) return undefined;
  return async (tx) => {
    await tx.orgAuditLog.create({
      data: {
        organizationId: member.organizationId,
        actorMembershipId: member.membershipId,
        category: "MEMBER",
        action: AUDIT_ACTIONS.MEMBER.APPOINTMENT_ALLOCATED_FOR_ORG,
        description: "Set a booking's times for the organization",
        details: { eventType, eventId, mode },
      },
    });
  };
}

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
      request.method,
    );
    if (authzError) return authzError;

    // Allocation is a host-side act; the consultee answers through reschedule.
    const hostActor = await resolveEventHostActor(
      authResult.session,
      eventType,
      eventId,
    );
    if (!hostActor) {
      return NextResponse.json(
        {
          error:
            "Only the expert or their organisation can set times for this booking.",
          errorCode: "ALLOCATE_FORBIDDEN",
        },
        { status: 403 },
      );
    }

    const canOverride = hostActor !== "host-org";

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

      // LAYER 2: Business Logic Validation & Allocation
      //
      // #1846 — the allocation itself, as a span. This is the single most
      // expensive operation on the booking funnel (a write transaction
      // that may re-validate conflicts, absorb the #440 GiST constraint and
      // write N occurrences), and with no metrics emission anywhere in the repo
      // its latency was unmeasurable. `Sentry.startSpan` is the same idiom
      // lib/payments/core/razorpay.ts uses for its gateway call — no new
      // dependency, no exporter — and it puts the number in the same trace as
      // the request that produced it.
      const resolvedExpectedTentativeSlotCount =
        body.expectedTentativeSlotCount ??
        (body.isReschedule === false && !body.topUp && mode !== "requested"
          ? 0
          : undefined);

      const auditInTx = await operatorAuditFor(
        authResult.session.user,
        hostActor,
        eventType,
        eventId,
        mode,
      );
      const result = await Sentry.startSpan(
        { op: "booking.allocate", name: `allocate.${eventType}` },
        () =>
          allocate({
            eventType,
            eventId,
            mode,
            slots: body.slots,
            // #837 — client dedupe key; a double-submit with the same value returns
            // the first batch instead of allocating twice.
            idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
            initialAllocation: body.initialAllocation,
            expectedTentativeSlotCount: resolvedExpectedTentativeSlotCount,
            // Waiving availability or placing fewer sessions is the expert's
            // (or staff's) call; a host-org operator allocates within the rules.
            override: body.override === true && canOverride,
            allowPartial: body.allowPartial === true && canOverride,
            topUp: body.topUp === true && canOverride,
            byConsultant: hostActor === "consultant",
            actorUserId: authResult.session.user.id,
            inTx: auditInTx,
          }),
      );

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
      let payExpiresAt: Date | null = null;
      if (awaitingPayment && eventType === "consultation") {
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
          await recordSystemErrorSafe({
            organizationId: null,
            category: "PAYMENT",
            summary:
              "Approval pay-link mint failed after allocation — approve again to retry",
            err: mint.error,
            context: { eventType, eventId },
          });
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
        if (mint.status === "minted") payExpiresAt = mint.payExpiresAt;
      }

      return NextResponse.json({
        data: result.appointments,
        warnings: result.warnings,
        // The client says how long the payer has, not "Confirmed", when the
        // approval is waiting on the pay order.
        awaitingPayment,
        // The pay window's end, clamped before the first session; null when
        // no link was minted by this call.
        payExpiresAt: payExpiresAt?.toISOString() ?? null,
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
      // The issue paths are developer detail: logged, never the user copy.
      if (validationError instanceof ZodError) {
        console.error(
          `${label} Validation failed after ${duration}ms:`,
          JSON.stringify(validationError.errors, null, 2),
        );
        return NextResponse.json(
          {
            error:
              "This request couldn't be read. Reload the page and try again.",
            errorCode: "VALIDATION_ERROR",
            eventId,
          },
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
