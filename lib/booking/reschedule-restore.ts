import type { Tx } from "@/lib/prisma";
import type { AppointmentStatus } from "@prisma/client";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";

import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "./transitions";

/**
 * Put a booking back exactly as it was before a reschedule released it. Three
 * endings share it (#1846): the initiator's withdrawal, expiry, where nobody
 * decided and the booking keeps its original times (#1527 decision 9), and a
 * decline, where the counterparty said no to the NEW time — which is not the
 * same as saying yes to losing the old one.
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
 * sweep, a parked booking for a decline) — see {@link isRestoreMiss}.
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
 * Move the parent request back off PENDING — the state a whole-booking
 * reschedule pushed it into.
 *
 * Shared by the restore and the park: the two differ only in whether the slots
 * came back, and both must land the parent somewhere, because PENDING with no
 * live session and no open proposal is exactly the shape the 48-hour "paid but
 * never allocated" sweep selects — and that sweep refunds in full
 * (`expireUnallocatedPaidSubscriptions`). A paid booking whose consultant
 * answered a reschedule would otherwise be refunded for a decision a human
 * made. See {@link parkParentForUnrestoredEnding}.
 */
async function settleParentAfterReschedule(
  tx: RestoreTx,
  request: RestorableRequest,
  meta: RestoreMeta,
): Promise<void> {
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

  await settleParentAfterReschedule(tx, request, meta);

  return restored;
}

/**
 * Park the parent of an ending whose restore could NOT land, so the booking
 * stops being the shape the refunding sweeps select.
 *
 * The declined-reschedule case: the counterparty said no, the original time was
 * taken while the proposal was open, so the sessions stay released and a human
 * has to place them. Leaving the parent in PENDING is not a neutral waiting
 * state — `expireUnallocatedPaidSubscriptions` matches PENDING + zero live
 * session + no open proposal + a payment captured over 48h ago, and refunds the
 * plan in full. A DECLINED proposal is no longer open, so the decline is
 * precisely what makes the booking match.
 *
 * There is no enum state for "a human must place these times": every candidate
 * is either already the swept state or a terminal one, and the schema is frozen
 * pre-launch, so the parent is settled to its ORIGIN instead — which for a paid
 * booking is APPROVED, out of the 48h cohort's reach. Durability for the
 * sessions still needing times is the caller's job: `AppointmentStatus` cannot
 * express it, so it must be signalled (see `declineProposal`).
 *
 * Returns the parent's state once settled, or null when the booking has no
 * 1:1 parent to settle. A state other than the origin comes back when there
 * was nothing to move — a partial proposal never flipped the parent, and a
 * never-approved one has no origin to restore to.
 */
export async function parkParentForUnrestoredEnding(
  tx: RestoreTx,
  request: RestorableRequest,
  meta: RestoreMeta,
): Promise<AppointmentStatus | null> {
  await settleParentAfterReschedule(tx, request, meta);

  const parent = request.appointment?.consultationId
    ? await tx.consultation.findUnique({
        where: { id: request.appointment.consultationId },
        select: { status: true },
      })
    : request.appointment?.subscriptionId
      ? await tx.subscription.findUnique({
          where: { id: request.appointment.subscriptionId },
          select: { status: true },
        })
      : null;
  return parent?.status ?? null;
}

/**
 * A restore that cannot land: the overlap constraint, or a parent request CAS
 * that missed. The proposal's own CAS miss is NOT one — that means it was
 * answered, and the answer wins.
 *
 * The single definition of "the restore could not happen", so every ending that
 * attempts one asks the same question instead of deciding it again. The
 * distinction matters because a restore miss is not a fault to retry: the
 * original time is gone, and no amount of waiting brings it back.
 */
export function isRestoreMiss(error: unknown): boolean {
  if (isExclusionViolation(error)) return true;
  return (
    error instanceof IllegalTransitionError &&
    error.entity !== "RescheduleRequest"
  );
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
