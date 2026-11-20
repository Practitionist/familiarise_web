// The allocator's one entry point: routes by mode, attempts the staged notices
// after commit, and turns any failure into a classified AllocationResult.

import { scheduleReason } from "@/lib/booking/allocation/schedule-choice";
import { reportSentryError } from "@/lib/observability/report";
import {
  AllocationRequest,
  AllocationResult,
  type AllocationErrorCode,
  type AllocationTxOptions,
} from "@/utils/scheduling-engine/types";
import {
  AllocationConflictError,
  AllocationError,
  AllocationIdempotencyMismatchError,
  SlotShortageError,
} from "@/utils/scheduling-engine/errors";
import {
  AllocationRaceError,
  SlotsTakenError,
} from "@/lib/booking/allocation/slot-batch";
import { attemptTrigger } from "@/lib/novu";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  classifyError,
  isModeledOutcome,
} from "@/lib/booking/allocation/classify";
import { autoAllocate } from "@/lib/booking/allocation/modes/auto";
import { manualAllocate } from "@/lib/booking/allocation/modes/manual";
import { useRequestedSlots } from "@/lib/booking/allocation/modes/use-requested";
import { getEventRelationField } from "@/lib/booking/allocation/identity";
import { findIdempotentAllocation } from "@/lib/booking/allocation/idempotency";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  ALLOCATOR_LOCK_RETRY_CONFIG,
  renewAppointmentLock,
  withAppointmentLock,
  withEventCheckoutLock,
} from "@/utils/appointmentlock";

/**
 * Main entry point for slot allocation
 * Routes to appropriate allocation method based on mode
 */
export async function allocate(
  request: AllocationRequest,
): Promise<AllocationResult> {
  try {
    const { stagedNotices, overageNotice, ...result } =
      await underAppointmentLock(request, () => dispatch(request));
    // The booked notice is staged inside the write transaction once real times
    // exist, so a rollback takes it and the relay delivers what this attempt
    // does not. A run that confirms a reschedule stages none: the reschedule
    // path's "moved" notice is the one both parties get.
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
  } catch (caught) {
    const replayed = await replayAfterKeyRace(request, caught);
    if (replayed && !(replayed instanceof Error)) return replayed;
    const error: unknown = replayed ?? caught;
    const { errorCode, httpStatus } = classifyError(error);
    // Every failure is reported. A modelled answer (slot taken, limit
    // reached, lost race) goes at info + expected; an outage (locking service
    // down, search out of time) is a warning that ships; anything else is a
    // fault at error level.
    const modeled = isModeledOutcome(error);
    const outage =
      errorCode === "BOOKING_LOCK_UNAVAILABLE" ||
      errorCode === "SEARCH_TIMEOUT";
    reportSentryError(error, {
      subsystem: "scheduling",
      op: "scheduling",
      expected: modeled,
      ...(outage
        ? {
            level: "warning" as const,
            fingerprint: ["allocator", errorCode],
          }
        : {}),
      extra: {
        mode: request.mode,
        eventType: request.eventType,
        eventId: request.eventId,
        errorCode,
        ...(error instanceof AllocationError && error.details
          ? { details: error.details }
          : {}),
      },
    });
    return {
      success: false,
      error: allocationFailureCopy(error, errorCode, httpStatus),
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
      ...(error instanceof SlotsTakenError
        ? { takenSlotStarts: error.takenSlotStarts }
        : {}),
      ...(error instanceof AllocationRaceError
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
}

/**
 * A same-key submit that lost the race to stamp its key replays the winner's
 * committed batch; the same key with different picks is the caller's 422.
 * Null when the failure was not that race (or the replay found nothing).
 */
async function replayAfterKeyRace(
  request: AllocationRequest,
  error: unknown,
): Promise<AllocationResult | AllocationIdempotencyMismatchError | null> {
  if (
    !request.idempotencyKey ||
    !isUniqueViolationOn(error, "allocationIdempotencyKey")
  ) {
    return null;
  }
  return findIdempotentAllocation(
    request.eventType,
    request.eventId,
    request.idempotencyKey,
    request.mode === "manual" ? request.slots : undefined,
  ).catch((replayError: unknown) =>
    replayError instanceof AllocationIdempotencyMismatchError
      ? replayError
      : null,
  );
}

/**
 * The user copy for a failed allocation: plain, actionable, never raw error
 * text. Typed allocation errors carry their own copy; lock and outage answers
 * get fixed copy (the lock family's messages address the buyer, not the
 * expert); anything else is indeterminate, since a 500 can fire on either side
 * of the commit.
 */
function allocationFailureCopy(
  error: unknown,
  errorCode: AllocationErrorCode,
  httpStatus: number,
): string {
  switch (errorCode) {
    case "LOCK_CONTENTION":
      return "Another change to this booking is in progress. Please try again in a moment.";
    case "BOOKING_LOCK_UNAVAILABLE":
      return "Booking is briefly unavailable. Please try again in a minute.";
    case "ILLEGAL_TRANSITION":
      return "This request was cancelled or expired while you were scheduling it. Reload to see its status.";
    case "SLOT_TAKEN":
      if (!(error instanceof AllocationConflictError)) {
        return "One of these times was just booked. Pick another time and try again.";
      }
      break;
    default:
      break;
  }
  if (httpStatus >= 500 && errorCode !== "SEARCH_TIMEOUT") {
    return "Couldn't save these times — check whether they appear, then retry.";
  }
  return error instanceof Error ? error.message : "Allocation failed";
}

/**
 * Lock order: event checkout → appointment → auto-allocate → consultee → slot
 * batch. A webinar or class plans under its checkout key, so no seat is sold
 * mid-plan; an event that already has its booking wrapper is allocated under
 * that wrapper's appointment lock, so no cancel or reschedule interleaves. A
 * caller already holding the grant hands it over and it is renewed, never
 * re-acquired.
 */
async function underAppointmentLock<T>(
  request: AllocationRequest,
  run: () => Promise<T>,
): Promise<T> {
  if (request.heldAppointmentLock) {
    await renewAppointmentLock(request.heldAppointmentLock);
    return run();
  }
  const underWrapper = async () => {
    const wrapper = await prisma.appointment.findFirst({
      where: {
        [`${getEventRelationField(request.eventType)}Id`]: request.eventId,
        deletedAt: null,
      } as Prisma.AppointmentWhereInput,
      select: { id: true },
    });
    return wrapper
      ? withAppointmentLock(wrapper.id, run, ALLOCATOR_LOCK_RETRY_CONFIG)
      : run();
  };
  return request.eventType === "webinar" || request.eventType === "class"
    ? withEventCheckoutLock(
        {
          appointmentType: request.eventType.toUpperCase(),
          eventId: request.eventId,
        },
        underWrapper,
      )
    : underWrapper();
}

/**
 * What the event had before this run, read on the server so the recorded
 * scheduling choice never trusts a client flag: whether a confirmed session
 * ever existed (a returned, cancelled or tombstoned one still counts, so the
 * plan's first choice is durable), and released sessions awaiting a new time.
 */
async function releasedBefore(request: AllocationRequest): Promise<number> {
  const relation = `${getEventRelationField(request.eventType)}Id`;
  return prisma.appointmentOccurrence.count({
    where: {
      appointment: {
        [relation]: request.eventId,
        deletedAt: null,
      } as Prisma.AppointmentWhereInput,
      deletedAt: null,
      isTentative: true,
      completionStatus: "RESCHEDULED",
    },
  });
}

/**
 * Mode router extracted so allocate() can post-process success uniformly
 * (PR 2c notification) without each mode knowing about it.
 */
export async function dispatch(
  request: AllocationRequest,
): Promise<AllocationResult> {
  const released = await releasedBefore(request);
  const txOptions: AllocationTxOptions = {
    approvableFrom: request.approvableFrom,
    inTx: request.inTx,
    actorUserId: request.actorUserId,
    checkOnly: request.checkOnly,
    historyReason: scheduleReason({
      mode:
        request.mode === "auto" || request.mode === "manual"
          ? request.mode
          : "requested",
      releasedBefore: released,
      confirmsReschedule: !!request.excludeRescheduleRequestId,
    }),
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
