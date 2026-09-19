import prisma, { type Tx } from "@/lib/prisma";
import type { AppointmentStatus } from "@prisma/client";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { withAppointmentLock } from "@/utils/appointmentlock";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionConsultationRequest,
  transitionRescheduleRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { notifyAppointmentRescheduled } from "@/lib/novu";
import { EMAIL_BUDGET_MS, sendAppointmentRescheduledEmail } from "@/lib/email";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";

/**
 * The initiator takes their own reschedule back, and the booking returns to
 * exactly what it was.
 *
 * ONLY withdrawal restores. Decline and expiry deliberately leave the slots
 * released: in both of those the consultee still wants to move and the
 * consultant simply has not agreed a time, so the booking belongs in their
 * allocate queue. A withdrawal is the opposite — the person who asked no
 * longer wants it, so nothing should have moved.
 *
 * This is cheap for one reason worth stating: a reschedule never rewrites
 * `startsAt`. The released rows still carry their original times, so restoring
 * is flipping two flags, not replaying data from a snapshot. (Auto-confirm is
 * the only path that ever wrote proposed times onto rows, and it no longer
 * does — it hands them to the allocator instead.)
 */
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
 * Where a withdrawn request goes back to. A never-approved PENDING request
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

export async function withdrawRescheduleRequest(args: {
  rescheduleRequestId: string;
  /** Must be the initiator. The caller is responsible for proving that. */
  withdrawnById: string;
}): Promise<{ withdrawn: boolean; reason?: string }> {
  const { rescheduleRequestId, withdrawnById } = args;

  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      id: true,
      status: true,
      initiatedById: true,
      releasedOccurrenceIds: true,
      appointmentId: true,
      createdAt: true,
      appointment: {
        select: {
          consultationId: true,
          subscriptionId: true,
        },
      },
    },
  });

  if (!request) return { withdrawn: false, reason: "PROPOSAL_NOT_FOUND" };

  // Withdrawal is the initiator's alone. The other side already has Decline,
  // which ends the same request with a different meaning and a different
  // outcome for the slots — giving them this too would just be a second
  // Decline wearing a friendlier word.
  if (request.initiatedById !== withdrawnById) {
    return { withdrawn: false, reason: "NOT_INITIATOR" };
  }
  if (!RESCHEDULE_OPEN_STATUSES.includes(request.status)) {
    return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
  }

  let restored = 0;
  const auditMeta = {
    actorUserId: withdrawnById,
    appointmentId: request.appointmentId,
    reason: "reschedule withdrawn",
  };
  const reportMissingOrigin = (entity: "CONSULTATION" | "SUBSCRIPTION") =>
    reportSentryMessage("Reschedule withdraw found no origin history row", {
      subsystem: "bookings",
      op: "reschedule-withdraw-origin",
      expected: true,
      extra: { rescheduleRequestId, entity },
    });
  try {
    // #1583 A-P0-04 — the withdraw is a lifecycle mutation like accept and
    // cancel; it serialises on the appointment atom, and the tx opens inside.
    await withAppointmentLock(request.appointmentId, () =>
      prisma.$transaction(async (tx) => {
        // The CAS is the guard: if the other party answered while we were
        // deciding, this matches zero rows and throws rather than un-releasing
        // slots that a concurrent accept has already re-confirmed.
        await transitionRescheduleRequest(tx, {
          actorUserId: withdrawnById,
          appointmentId: request.appointmentId,
          where: { id: request.id },
          to: "WITHDRAWN",
          data: { resolvedById: withdrawnById },
        });

        // Reverses exactly what the reschedule did to these rows. The from-set
        // rides in `fromIn` rather than the WHERE (the helper overwrites
        // `completionStatus` there), and `allowZero` keeps the outcome below
        // intact: restoring nothing means the released rows are gone, which is
        // what an allocation replacing them does, not a lost CAS.
        // No appointmentId: a whole-subscription reschedule releases slots across
        // sibling appointments, so each row's history belongs to the appointment
        // it actually sits on, not to the one the proposal was opened against.
        restored = await transitionOccurrenceCompletion(tx, {
          actorUserId: withdrawnById,
          where: { id: { in: request.releasedOccurrenceIds } },
          to: "SCHEDULED",
          data: { isTentative: false },
          fromIn: ["RESCHEDULED"],
          allowZero: true,
        });

        // A consultation reschedule sends the booking back to PENDING so it
        // re-enters the consultant's queue; withdrawing has to undo that or the
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
        if (request.appointment?.consultationId) {
          const origin = await readRescheduleOrigin(
            tx,
            "CONSULTATION",
            request.appointment.consultationId,
            request.createdAt,
          );
          if (origin === undefined) reportMissingOrigin("CONSULTATION");
          const to = restoreTargetFor(origin, "APPROVED");
          if (to) {
            await transitionConsultationRequest(tx, {
              ...auditMeta,
              where: { id: request.appointment.consultationId },
              to,
              fromIn: ["PENDING"],
            });
          }
        }

        // E2E-audit P1 fix — subscriptions need the same undo. #448 kept
        // PARTIAL subscription reschedules from flipping the parent, but the
        // whole-booking reschedule (no slotIds) DOES flip it to PENDING via the
        // reschedule route. Leaving a withdrawn, paid plan in PENDING strands
        // it in the consultant's request queue, where expirePendingSubscriptions
        // can EXPIRE + refund a plan that still owes (or already delivered)
        // sessions. Restore only when the parent actually sits in PENDING —
        // i.e., this proposal was a whole-booking flip; partial proposals left
        // the parent APPROVED and must not be touched (#448). The CAS keeps the
        // concurrent-answer race modelled.
        if (request.appointment?.subscriptionId) {
          const sub = await tx.subscription.findUnique({
            where: { id: request.appointment.subscriptionId },
            select: { status: true },
          });
          if (sub?.status === "PENDING") {
            const origin = await readRescheduleOrigin(
              tx,
              "SUBSCRIPTION",
              request.appointment.subscriptionId,
              request.createdAt,
            );
            if (origin === undefined) reportMissingOrigin("SUBSCRIPTION");
            // No origin row and the parent sits in PENDING: the request row
            // cannot tell a whole-booking flip from a PARTIAL proposal on a
            // never-approved subscription (#448 leaves that parent untouched),
            // so the safe direction is no write — promoting it would be the
            // consultant-gate bypass this restore exists to prevent.
            const to = restoreTargetFor(origin, null);
            if (to) {
              await transitionSubscriptionRequest(tx, {
                ...auditMeta,
                where: { id: request.appointment.subscriptionId },
                to,
                fromIn: ["PENDING"],
              });
            }
          }
        }
      }),
    );
  } catch (err) {
    // A lost CAS is a MODELLED outcome, not a fault: the other party accepted
    // or declined while this withdrawal was in flight. Reporting it as an error
    // would page on ordinary two-party contention, and the route would answer
    // 500 instead of the 409 this actually is.
    if (err instanceof IllegalTransitionError) {
      return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
    }
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-withdraw",
      extra: {
        rescheduleRequestId,
        releasedOccurrenceIds: request.releasedOccurrenceIds,
      },
    });
    throw err;
  }

  // The CAS moves RESCHEDULED rows only, so a row whose status drifted stays
  // released while the request is already WITHDRAWN — a half-restored booking
  // that otherwise reports success and shows nothing anywhere. The withdrawal
  // itself is committed and correct, so this reports rather than throws.
  //
  // Restoring NOTHING is a different animal and must not page: it means the
  // released rows are simply gone, which is what an allocation replacing them
  // does. Withdrawing after that is a no-op the user cannot have intended, not
  // a fault in this code. A PARTIAL restore is the genuine anomaly the check
  // was written for, because it leaves one booking in two states at once.
  if (restored !== request.releasedOccurrenceIds.length) {
    reportSentryError(
      new Error(
        `Withdrawal restored ${restored} of ${request.releasedOccurrenceIds.length} released slots.`,
      ),
      {
        subsystem: "bookings",
        op: "reschedule-withdraw-partial",
        expected: restored === 0,
        extra: {
          rescheduleRequestId,
          releasedOccurrenceIds: request.releasedOccurrenceIds,
          restored,
        },
      },
    );
  }

  // PR 2e — the initiator withdrew their own proposal; both parties learn
  // the booking stays at its original times. Fire-and-forget.
  try {
    const detail = await prisma.rescheduleRequest.findUnique({
      where: { id: rescheduleRequestId },
      select: {
        initiatedById: true,
        appointment: {
          select: {
            id: true,
            organizationId: true,
            appointmentType: true,
            consultation: {
              select: {
                requestedBy: {
                  select: { user: { select: { id: true, name: true } } },
                },
                consultationPlan: {
                  select: {
                    title: true,
                    consultantProfile: {
                      select: { user: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
            },
            subscription: {
              select: {
                requestedBy: {
                  select: { user: { select: { id: true, name: true } } },
                },
                subscriptionPlan: {
                  select: {
                    title: true,
                    consultantProfile: {
                      select: { user: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const appt = detail?.appointment;
    const side = appt?.consultation ?? appt?.subscription;
    if (detail && side && appt) {
      const isConsultation = "consultationPlan" in side;
      const planTitle = isConsultation
        ? side.consultationPlan.title
        : side.subscriptionPlan.title;
      const consultantUser = isConsultation
        ? side.consultationPlan.consultantProfile.user
        : side.subscriptionPlan.consultantProfile.user;
      const consulteeUser = side.requestedBy.user;
      const withdrawnUserIds = [
        detail.initiatedById,
        consultantUser.id,
        consulteeUser.id,
      ].filter((id, i, arr) => arr.indexOf(id) === i);
      await notifyAppointmentRescheduled(withdrawnUserIds, {
        ...notificationScope(appt.organizationId),
        appointmentType: appt.appointmentType,
        consultantName: consultantUser.name || "Consultant",
        consulteeName: consulteeUser.name || "Consultee",
        planTitle,
        dashboardUrl: notificationHref(appt.organizationId, "appointments"),
        outcome: "WITHDRAWN",
      });
      // #1653 — the email twin; the sender never throws.
      await sendAppointmentRescheduledEmail(
        {
          appointmentId: appt.id,
          userIds: withdrawnUserIds,
          outcome: "WITHDRAWN",
          appointmentType: appt.appointmentType,
          dashboardUrl: notificationHref(appt.organizationId, "appointments"),
        },
        EMAIL_BUDGET_MS.REQUEST,
      );
    }
  } catch (notifyErr) {
    reportSentryError(
      notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
      {
        subsystem: "bookings",
        op: "reschedule-withdraw-notify",
        expected: true,
      },
    );
  }

  return { withdrawn: true };
}
