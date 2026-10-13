/**
 * #1527 decision 6 / #1846 CT-02 — Delete on an offering exists only while
 * nothing has ever touched it, and it is decided in the database, not in a read.
 *
 * `Payment.appointment` and every `Appointment.{consultation,subscription,
 * webinar,class}Id` foreign key cascade on delete, so the old read-then-delete
 * routes had a window: a checkout that minted a PENDING Payment between the
 * guard's read and the delete had that Payment (and its legs) cascaded away,
 * and its later capture found no row. The guard now rides the DELETE's WHERE
 * (doctrine rule 2), the read and the delete share one Serializable
 * transaction, and the whole thing runs under the lock checkout takes for the
 * same offering, so a buyer and a delete serialise instead of interleaving.
 *
 * A zero-row delete answers OFFERING_IN_USE (409) and points at Archive,
 * which is what an offering anything has referenced gets instead.
 */
import { Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { reportSentryMessage } from "@/lib/observability/report";
import { deleteRecordingAssets } from "@/lib/stream/recording-storage";
import {
  EventCheckoutBusyError,
  EventCheckoutLockUnavailableError,
  lockEventCheckout,
  REQUEST_PATH_RETRY_CONFIG,
  unlockEventCheckout,
} from "@/utils/appointmentlock";

export type OfferingKind =
  "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";

export class OfferingInUseError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "OFFERING_IN_USE" as const;
  constructor(kind: OfferingKind) {
    super(
      `This ${kind.toLowerCase()} has bookings or payments, so it can't be deleted. Archive it instead.`,
    );
    this.name = "OfferingInUseError";
  }
}

// #1846 — the guards live in one module the Offerings card reads too.
export {
  UNTOUCHED_CONSULTATION_PLAN,
  UNTOUCHED_EVENT,
  UNTOUCHED_SUBSCRIPTION_PLAN,
} from "@/lib/offerings/delete-guard";

/**
 * The lock must outlive every attempt the retry loop can make, or a checkout
 * could take the expired key while a delete attempt is still running. Two
 * attempts of maxWait + timeout are 50 s; 75 s covers them, the retry backoff
 * and the lock's clock-drift allowance.
 */
const TX_MAX_WAIT_MS = 10_000;
const TX_TIMEOUT_MS = 15_000;
const DELETE_MAX_RETRIES = 1;
const OFFERING_DELETE_LOCK_TTL_MS = 75_000;

/** Recordings hanging off the offering's appointments; the cascade removes their rows, not their objects. */
function offeringRecordingsWhere(
  kind: OfferingKind,
  id: string,
): Prisma.RecordingWhereInput {
  const appointment: Prisma.AppointmentWhereInput =
    kind === "WEBINAR"
      ? { webinarId: id }
      : kind === "CLASS"
        ? { classId: id }
        : kind === "CONSULTATION"
          ? { consultation: { consultationPlanId: id } }
          : {
              OR: [
                { subscription: { subscriptionPlanId: id } },
                { trial: { subscriptionPlanId: id } },
              ],
            };
  return { meeting: { occurrence: { appointment } } };
}

/** Best effort after commit: delete the stored objects of cascaded recordings, one report per request. */
async function deleteCascadedRecordingAssets(
  kind: OfferingKind,
  id: string,
  recordings: { id: string; storagePath: string | null }[],
): Promise<void> {
  const failed: string[] = [];
  for (const recording of recordings) {
    const result = await deleteRecordingAssets(recording).catch(
      (error: unknown) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    if (!result.success) failed.push(recording.id);
  }
  if (failed.length > 0) {
    reportSentryMessage("Recording objects left after an offering delete", {
      subsystem: "stream",
      op: "offering-delete-recordings",
      level: "warning",
      fingerprint: ["offering-delete", "recording-assets"],
      extra: { kind, id, recordingIds: failed.slice(0, 50) },
    });
  }
}

/**
 * Run `remove` under the offering's checkout lock in one Serializable
 * transaction. `remove` returns the deleted row, `null` when the offering is
 * missing or not the caller's, and throws OfferingInUseError when the guard
 * matched nothing. Checkout keys its lock by webinar or class id and by
 * subscription plan id; a consultation plan has no checkout key (checkout
 * locks its slot atoms instead), so there the Serializable transaction and the
 * in-WHERE guard carry the race on their own. Recording objects of the
 * cascaded rows are deleted after the commit.
 */
export async function deleteUntouchedOffering<T>(
  kind: OfferingKind,
  id: string,
  remove: (tx: Tx) => Promise<T | null>,
): Promise<T | null> {
  const lock = await lockEventCheckout(
    kind,
    id,
    OFFERING_DELETE_LOCK_TTL_MS,
    REQUEST_PATH_RETRY_CONFIG,
  );
  let outcome: {
    deleted: T | null;
    recordings: { id: string; storagePath: string | null }[];
  };
  try {
    outcome = await withSerializableRetry(
      () =>
        prisma.$transaction(
          async (tx) => {
            const recordings = await tx.recording.findMany({
              where: offeringRecordingsWhere(kind, id),
              select: { id: true, storagePath: true },
            });
            return { deleted: await remove(tx), recordings };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: TX_MAX_WAIT_MS,
            timeout: TX_TIMEOUT_MS,
          },
        ),
      DELETE_MAX_RETRIES,
    );
  } finally {
    await unlockEventCheckout(lock);
  }
  if (outcome.deleted !== null && outcome.recordings.length > 0) {
    await deleteCascadedRecordingAssets(kind, id, outcome.recordings);
  }
  return outcome.deleted;
}

/** The route answer for this module's refusals, or null for anything else. */
export function offeringDeleteRefusal(
  error: unknown,
): { status: number; body: { error: string; code: string } } | null {
  if (
    error instanceof OfferingInUseError ||
    error instanceof EventCheckoutBusyError ||
    error instanceof EventCheckoutLockUnavailableError
  ) {
    return {
      status: error.httpStatus,
      body: { error: error.message, code: error.code },
    };
  }
  return null;
}
