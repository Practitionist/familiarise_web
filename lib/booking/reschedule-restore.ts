import type { Tx } from "@/lib/prisma";
import type { AppointmentStatus } from "@prisma/client";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";

import {
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "./transitions";

/**
 * Put a booking back exactly as it was before a reschedule released it. Two
 * endings share it (#1846): the initiator's withdrawal, and expiry, where
 * nobody decided and the booking keeps its original times (#1527 decision 9).
 * A decline is the one ending that keeps the slots released, because someone
 * did decide: the consultee still wants to move and the consultant has not
 * agreed a time, so the booking belongs in their allocate queue.
 *
 * This is cheap for one reason worth stating: a reschedule never rewrites
 * `startsAt`. The released rows still carry their original times, so restoring
 * is flipping two flags, not replaying data from a snapshot. (Auto-confirm is
 * the only path that ever wrote proposed times onto rows, and it no longer
 * does — it hands them to the allocator instead.)
 *
 * The flip back to non-tentative can meet `occurrence_no_confirmed_overlap`
 * (SQLSTATE 23P01) when the consultant's original time was taken while the
 * proposal was open. That aborts the caller's transaction; each caller decides
 * what the answer is (a typed 409 for withdraw, an unrestored expiry for the
 * sweep) with `isExclusionViolation` from `lib/db/pg-errors`.
 */

export interface RestorableRequest {
  id: string;
  appointmentId: string;
  createdAt: Date;
  releasedOccurrenceIds: string[];
  appointment: {
    consultationId: string | null;
    subscriptionId: string | null;
  } | null;
}

export interface RestoreMeta {
  actorUserId: string | null;
  reason: string;
  /** The Sentry op prefix, so each ending's reports stay apart. */
  op: string;
}

type RestoreTx = Pick<
  Tx,
  | "appointmentOccurrence"
  | "bookingStatusHistory"
  | "consultation"
  | "subscription"
>;

/**
 * #1589 R-P1-01 / R-P1-04 — the status the request held BEFORE the reschedule
 * flipped it to PENDING, read from the history row the reschedule route wrote
 * in the same transaction as the proposal (#1333). `undefined` means no such
 * row: a pre-#1333 proposal, or a partial one that never re-stamped.
 */
async function readRescheduleOrigin(
  tx: Pick<Tx, "bookingStatusHistory">,
  entity: "CONSULTATION" | "SUBSCRIPTION",
  entityId: string,
  requestCreatedAt: Date,
): Promise<string | undefined> {
  const skewMs = 5_000;
  const origin = await tx.bookingStatusHistory.findFirst({
    where: {
      entity,
      entityId,
      toStatus: "PENDING",
      createdAt: {
        gte: new Date(requestCreatedAt.getTime() - skewMs),
        lte: new Date(requestCreatedAt.getTime() + skewMs),
      },
    },
    orderBy: { createdAt: "desc" },
    select: { fromStatus: true },
  });
  // appendHistory renders a lost pre-read as the literal "UNKNOWN" (A12); that
  // is no origin either, so the fallback and its report fire for it too.
  if (!origin || origin.fromStatus === "UNKNOWN") return undefined;
  return origin.fromStatus;
}

/**
 * Where a restored request goes back to. A never-approved PENDING request
 * must not come back APPROVED (consultant-gate bypass) and an unpaid
 * APPROVED_PENDING_PAYMENT one must not come back APPROVED (payment bypass).
 * `null` means the parent never left PENDING, so nothing is written.
 */
function restoreTargetFor(
  origin: string | undefined,
  fallback: AppointmentStatus | null,
): AppointmentStatus | null {
  switch (origin) {
    case "PENDING":
      return null;
    case "APPROVED_PENDING_PAYMENT":
      return "APPROVED_PENDING_PAYMENT";
    // SCHEDULED is unreachable for requests (docs/booking/18-state-machines.md),
    // so APPROVED is the only live shape it can stand for.
    case "APPROVED":
    case "SCHEDULED":
      return "APPROVED";
    default:
      return fallback;
  }
}

/**
 * Restore the released slots and the parent request on the caller's
 * transaction. The caller has already ended the proposal through its CAS, so
 * a concurrent answer has lost before this runs. Returns how many slots came
 * back.
 */
export async function restoreRescheduledBooking(
  tx: RestoreTx,
  request: RestorableRequest,
  meta: RestoreMeta,
): Promise<number> {
  const auditMeta = {
    actorUserId: meta.actorUserId,
    appointmentId: request.appointmentId,
    reason: meta.reason,
  };
  const reportMissingOrigin = (entity: "CONSULTATION" | "SUBSCRIPTION") =>
    reportSentryMessage("Reschedule restore found no origin history row", {
      subsystem: "bookings",
      op: `${meta.op}-origin`,
      expected: true,
      extra: { rescheduleRequestId: request.id, entity },
    });

  // Reverses exactly what the reschedule did to these rows. The from-set
  // rides in `fromIn` rather than the WHERE (the helper overwrites
  // `completionStatus` there), and `allowZero` keeps the outcome intact:
  // restoring nothing means the released rows are gone, which is what an
  // allocation replacing them does, not a lost CAS.
  // No appointmentId: a whole-subscription reschedule releases slots across
  // sibling appointments, so each row's history belongs to the appointment it
  // actually sits on, not to the one the proposal was opened against.
  const restored = await transitionOccurrenceCompletion(tx, {
    actorUserId: meta.actorUserId,
    reason: meta.reason,
    where: { id: { in: request.releasedOccurrenceIds } },
    to: "SCHEDULED",
    data: { isTentative: false },
    fromIn: ["RESCHEDULED"],
    allowZero: true,
  });

  // A consultation reschedule sends the booking back to PENDING so it
  // re-enters the consultant's queue; restoring has to undo that or the
  // consultee is left with a confirmed-looking booking still sitting in
  // someone's inbox.
  //
  // fromIn narrows to PENDING rather than the map's default: this edge is
  // only ever undoing the reschedule's own flip, so an APPROVED booking
  // reaching here means the state moved under us and should throw, not be
  // re-stamped.
  //
  // #1589 R-P1-01 — "back to what it was" is the ORIGIN status, not
  // APPROVED: a PENDING origin writes nothing, an unpaid origin stays
  // unpaid (the pay-link expiry cohort keeps it), and a missing origin
  // keeps the historical APPROVED restore and reports once.
  const consultationId = request.appointment?.consultationId;
  if (consultationId) {
    const origin = await readRescheduleOrigin(
      tx,
      "CONSULTATION",
      consultationId,
      request.createdAt,
    );
    if (origin === undefined) reportMissingOrigin("CONSULTATION");
    const to = restoreTargetFor(origin, "APPROVED");
    if (to) {
      await transitionConsultationRequest(tx, {
        ...auditMeta,
        where: { id: consultationId },
        to,
        fromIn: ["PENDING"],
      });
    }
  }

  // E2E-audit P1 fix — subscriptions need the same undo. #448 kept PARTIAL
  // subscription reschedules from flipping the parent, but the whole-booking
  // reschedule (no slotIds) DOES flip it to PENDING via the reschedule route.
  // Leaving a restored, paid plan in PENDING strands it in the consultant's
  // request queue, where expirePendingSubscriptions can EXPIRE + refund a plan
  // that still owes (or already delivered) sessions. Restore only when the
  // parent actually sits in PENDING — i.e., this proposal was a whole-booking
  // flip; partial proposals left the parent APPROVED and must not be touched
  // (#448). The CAS keeps the concurrent-answer race modelled.
  const subscriptionId = request.appointment?.subscriptionId;
  if (subscriptionId) {
    const sub = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: { status: true },
    });
    if (sub?.status === "PENDING") {
      const origin = await readRescheduleOrigin(
        tx,
        "SUBSCRIPTION",
        subscriptionId,
        request.createdAt,
      );
      if (origin === undefined) reportMissingOrigin("SUBSCRIPTION");
      // No origin row and the parent sits in PENDING: the request row cannot
      // tell a whole-booking flip from a PARTIAL proposal on a never-approved
      // subscription (#448 leaves that parent untouched), so the safe
      // direction is no write — promoting it would be the consultant-gate
      // bypass this restore exists to prevent.
      const to = restoreTargetFor(origin, null);
      if (to) {
        await transitionSubscriptionRequest(tx, {
          ...auditMeta,
          where: { id: subscriptionId },
          to,
          fromIn: ["PENDING"],
        });
      }
    }
  }

  return restored;
}

/**
 * The CAS moves RESCHEDULED rows only, so a row whose status drifted stays
 * released while the request has already ended — a half-restored booking that
 * otherwise reports success and shows nothing anywhere. The ending itself is
 * committed and correct, so this reports rather than throws.
 *
 * Restoring NOTHING is a different animal and must not page: it means the
 * released rows are simply gone, which is what an allocation replacing them
 * does. A PARTIAL restore is the genuine anomaly, because it leaves one
 * booking in two states at once.
 */
export function reportPartialRestore(
  request: Pick<RestorableRequest, "id" | "releasedOccurrenceIds">,
  restored: number,
  op: string,
): void {
  if (restored === request.releasedOccurrenceIds.length) return;
  reportSentryError(
    new Error(
      `${op}: restored ${restored} of ${request.releasedOccurrenceIds.length} released slots.`,
    ),
    {
      subsystem: "bookings",
      op: `${op}-partial`,
      expected: restored === 0,
      extra: {
        rescheduleRequestId: request.id,
        releasedOccurrenceIds: request.releasedOccurrenceIds,
        restored,
      },
    },
  );
}
