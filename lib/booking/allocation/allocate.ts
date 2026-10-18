// The allocator's one entry point: routes by mode, attempts the staged notices
// after commit, and turns any failure into a classified AllocationResult.

import { reportSentryError } from "@/lib/observability/report";
import {
  AllocationRequest,
  AllocationResult,
  type AllocationTxOptions,
} from "@/utils/scheduling-engine/types";
import { SlotShortageError } from "@/utils/scheduling-engine/errors";
import { attemptTrigger } from "@/lib/novu";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  classifyError,
  isModeledOutcome,
} from "@/lib/booking/allocation/classify";
import { autoAllocate } from "@/lib/booking/allocation/modes/auto";
import { manualAllocate } from "@/lib/booking/allocation/modes/manual";
import { useRequestedSlots } from "@/lib/booking/allocation/modes/use-requested";

/**
 * Main entry point for slot allocation
 * Routes to appropriate allocation method based on mode
 */
export async function allocate(
  request: AllocationRequest,
): Promise<AllocationResult> {
  try {
    const { stagedNotices, overageNotice, ...result } = await dispatch(request);
    // PR 2c — the allocation-time notification (audit G1 / B9's promised
    // completion): APPOINTMENT_BOOKED was deliberately skipped at payment
    // when no slots existed; THIS is where the times finally exist, so both
    // parties hear about them from every caller path (routes, auto-confirm,
    // accept-proposal).
    // #1697 item 5 — the outbox rows were STAGED inside the write
    // transaction (ADR 27), so a rollback takes them and an instance freeze
    // after the response cannot lose them: the relay delivers what this
    // attempt does not. Only the attempt is post-commit and best-effort.
    // #1206 — a top-up that placed nothing stages nothing (see the
    // suppressor at the staging site), so nothing is attempted here.
    if (stagedNotices && stagedNotices.length > 0) {
      void scheduleAfter(async () => {
        for (const staged of stagedNotices) await attemptTrigger(staged);
      }, "scheduling.allocate.post-commit");
    }
    // The allocation transaction has committed, so the overage it settled is real.
    if (overageNotice) {
      try {
        const { notifyOverageDueAfterCommit } =
          await import("@/lib/payments/billing/overage-settlement");
        void notifyOverageDueAfterCommit(overageNotice);
      } catch (notifyErr) {
        // A lost notice never turns a committed allocation into a failure.
        reportSentryError(notifyErr, {
          subsystem: "scheduling",
          op: "allocate.overage-notice",
          level: "warning",
        });
      }
    }
    return result;
  } catch (error) {
    const { errorCode, httpStatus } = classifyError(error);
    // Full-coverage policy: every error reaching here is reported, modelled
    // outcome or not, so volume/pattern of ordinary answers (slot taken,
    // limit reached, lost CAS race) is visible in Sentry too — but at
    // info + expected:true so a dashboard scan can't mistake "no slots
    // available" for a database failure. Real faults keep the default
    // error level with no expected tag.
    // #1721 QA — every 4xx classification is an answer, including the
    // untyped legacy throws classifyError maps by message; only a 5xx is a fault.
    const modeled = isModeledOutcome(error) || httpStatus < 500;
    reportSentryError(error, {
      subsystem: "scheduling",
      op: "scheduling",
      expected: modeled,
      extra: {
        mode: request.mode,
        eventType: request.eventType,
        eventId: request.eventId,
        errorCode,
      },
    });
    return {
      success: false,
      // 5xx answers never carry raw error text: pool timeouts, Prisma
      // validation dumps, and constraint internals are operator detail
      // (already in Sentry above), not user copy. Indeterminate wording —
      // a 500 can fire on either side of the commit.
      error:
        httpStatus >= 500
          ? "Couldn't save these times — check whether they appear, then retry."
          : error instanceof Error
            ? error.message
            : "Allocation failed",
      errorCode,
      httpStatus,
      // #1206 — a shortage refusal carries the count the client needs to
      // offer "allocate N now, the rest when availability opens".
      ...(error instanceof SlotShortageError
        ? {
            placeableSessions: error.placeableSessions,
            requiredSessions: error.requiredSessions,
          }
        : {}),
    };
  }
}

/**
 * Mode router extracted so allocate() can post-process success uniformly
 * (PR 2c notification) without each mode knowing about it.
 */
export async function dispatch(
  request: AllocationRequest,
): Promise<AllocationResult> {
  const txOptions: AllocationTxOptions = {
    approvableFrom: request.approvableFrom,
    inTx: request.inTx,
  };
  switch (request.mode) {
    case "auto":
      return await autoAllocate(
        request.eventType,
        request.eventId,
        request.idempotencyKey,
        request.initialAllocation,
        request.expectedTentativeSlotCount,
        request.allowPartial,
        request.topUp,
        request.excludeRescheduleRequestId,
        txOptions,
      );

    case "manual":
      if (!request.slots || request.slots.length === 0) {
        return {
          success: false,
          error: "Slots are required for manual allocation",
          errorCode: "VALIDATION_ERROR",
          httpStatus: 400,
        };
      }
      return await manualAllocate(
        request.eventType,
        request.eventId,
        request.slots,
        request.idempotencyKey,
        request.initialAllocation,
        request.wideLock,
        request.expectedTentativeSlotCount,
        request.excludeRescheduleRequestId,
        // The consultant explicitly accepting these times as-is. Gated to
        // the event consultant by the route (canOverride) before dispatch.
        request.override,
        request.allowPartial,
        request.topUp,
        txOptions,
      );

    case "requested":
      return await useRequestedSlots(
        request.eventType,
        request.eventId,
        request.initialAllocation,
        request.idempotencyKey,
        request.override,
        request.expectedTentativeSlotCount,
        txOptions,
      );

    default:
      return {
        success: false,
        error: `Invalid allocation mode: ${request.mode}`,
        errorCode: "INVALID_MODE",
        httpStatus: 400,
      };
  }
}
