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
import {
  EventCheckoutBusyError,
  EventCheckoutLockUnavailableError,
  lockEventCheckout,
  REQUEST_PATH_RETRY_CONFIG,
  unlockEventCheckout,
} from "@/utils/appointmentlock";

export type OfferingKind =
  | "CONSULTATION"
  | "SUBSCRIPTION"
  | "WEBINAR"
  | "CLASS";

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

/**
 * A booking or a payment of any status: every Payment, PENDING and FAILED
 * included, cascades with its appointment, so "active" is the wrong filter.
 */
const APPOINTMENT_HAS_HISTORY = {
  OR: [
    { payment: { some: {} } },
    { participants: { some: { role: "CONSULTEE" } } },
  ],
} satisfies Prisma.AppointmentWhereInput;

/** The in-WHERE guard for a webinar or class instance. */
export const UNTOUCHED_EVENT = {
  NOT: { appointment: { is: APPOINTMENT_HAS_HISTORY } },
} satisfies Prisma.WebinarWhereInput & Prisma.ClassWhereInput;

/** The in-WHERE guard for a consultation plan: no request row of any status. */
export const UNTOUCHED_CONSULTATION_PLAN = {
  consultations: { none: {} },
} satisfies Prisma.ConsultationPlanWhereInput;

/**
 * The in-WHERE guard for a subscription plan: no request and no trial (Trial's
 * plan key is RESTRICT, so a trial made the old delete fail as a 500).
 */
export const UNTOUCHED_SUBSCRIPTION_PLAN = {
  subscriptions: { none: {} },
  trials: { none: {} },
} satisfies Prisma.SubscriptionPlanWhereInput;

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

/**
 * Run `remove` under the offering's checkout lock in one Serializable
 * transaction. `remove` returns the deleted row, `null` when the offering is
 * missing or not the caller's, and throws OfferingInUseError when the guard
 * matched nothing. Checkout keys its lock by webinar or class id and by
 * subscription plan id; a consultation plan has no checkout key (checkout
 * locks its slot atoms instead), so there the Serializable transaction and the
 * in-WHERE guard carry the race on their own.
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
  try {
    return await withSerializableRetry(
      () =>
        prisma.$transaction(remove, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: TX_MAX_WAIT_MS,
          timeout: TX_TIMEOUT_MS,
        }),
      DELETE_MAX_RETRIES,
    );
  } finally {
    await unlockEventCheckout(lock);
  }
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
