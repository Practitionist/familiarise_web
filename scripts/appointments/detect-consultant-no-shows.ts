/**
 * Consultant No-Show Detection + Handling — Core Logic (#471)
 *
 * The platform promises a full refund when the CONSULTANT no-shows a paid
 * session, but only the foundation data existed (MeetingAttendance stamped by
 * lib/stream/session-handlers.ts). This job closes the loop: detect confirmed
 * consultant no-shows, auto-refund (reusing B1's refundPayment path, #990),
 * mark the booking cancelled, and notify both parties.
 *
 * Imported by:
 * - jobs/appointments/detect-consultant-no-shows.ts (GitHub Actions)
 *
 * Schedule: hourly.
 *
 * Scope: CONSULTATION only — a single-session, single-consultant exclusive
 * booking where a full refund of the one payment is the correct remedy.
 * Subscriptions are multi-session (a per-session no-show is a partial refund of
 * one session out of N, which needs its own design); see the TODO below.
 */

import prisma from "../../lib/prisma";
import {
  AppointmentStatus,
  CancellationReason,
  PaymentStatus,
  SlotCompletionStatus,
} from "@prisma/client";
import {
  notifyAppointmentCancelled,
  notifyRefundProcessed,
} from "../../lib/novu/service";
import { getAppUrl } from "../../lib/url";
import { refundPayment } from "@/lib/payments/operations/refund";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { CANCELLABLE_FROM } from "@/lib/booking/transitions";

// Conservative grace window: a session must have ended at least this long ago
// before we treat a missing consultant as a no-show. Well past the slot end so
// a late join or a delayed Stream participant-webhook cannot cause a false
// positive (which would wrongly cancel + refund a session the consultant DID
// attend). Money movement is hard to reverse, so this is deliberately generous.
const NO_SHOW_GRACE_MINUTES = 120;

export interface NoShowResult {
  success: boolean;
  detected: number;
  refunded: number;
  errors: string[];
  timestamp: string;
}

export async function detectConsultantNoShows(): Promise<NoShowResult> {
  // #476 — locked at the core so every entry shares one mutual exclusion.
  // Fail-open: the CAS claim + refundPayment's refundable-balance guard already
  // make the work repeat-safe; the lock is belt-and-braces against overlap.
  return withCronLock("detect-consultant-no-shows", { failMode: "open" }, () =>
    detectConsultantNoShowsUnlocked(),
  );
}

async function detectConsultantNoShowsUnlocked(): Promise<NoShowResult> {
  const errors: string[] = [];
  let detected = 0;
  let refunded = 0;

  const graceCutoff = new Date(Date.now() - NO_SHOW_GRACE_MINUTES * 60 * 1000);

  console.log("🔍 Scanning for consultant no-shows...");
  console.log(`   Grace window: ${NO_SHOW_GRACE_MINUTES} min after session end`);

  // Candidate consultations: still active (not already cancelled/completed),
  // paid, whose slots have all ended past the grace window and where a
  // MeetingSession actually happened (the call took place — a precondition for
  // "the consultee showed up but the consultant didn't").
  const candidates = await prisma.consultation.findMany({
    where: {
      status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
      appointment: {
        payment: {
          some: {
            paymentStatus: PaymentStatus.SUCCEEDED,
            amount: { gt: 0 },
            deletedAt: null,
          },
        },
        slotsOfAppointment: {
          every: { endsAt: { lt: graceCutoff } },
          some: { endsAt: { lt: graceCutoff }, meetingSession: { isNot: null } },
        },
      },
    },
    include: {
      consultationPlan: {
        select: {
          title: true,
          consultantProfile: {
            select: { userId: true, user: { select: { name: true } } },
          },
        },
      },
      requestedBy: {
        select: { userId: true, user: { select: { name: true } } },
      },
      appointment: {
        include: {
          payment: {
            select: { id: true, amount: true, currency: true, paymentStatus: true },
          },
          slotsOfAppointment: {
            include: {
              meetingSession: {
                include: { attendances: { select: { userId: true } } },
              },
            },
          },
        },
      },
    },
  });

  console.log(`Found ${candidates.length} paid, ended candidates to check`);

  for (const consultation of candidates) {
    try {
      const consultantUserId =
        consultation.consultationPlan?.consultantProfile?.userId;
      const consulteeUserId = consultation.requestedBy?.userId;
      if (!consultantUserId || !consulteeUserId) {
        // Cannot attribute presence without both user ids — skip, don't guess.
        continue;
      }

      // Presence across every session tied to this booking's slots.
      const sessions = (consultation.appointment?.slotsOfAppointment ?? [])
        .map((s) => s.meetingSession)
        .filter((m): m is NonNullable<typeof m> => !!m);
      if (sessions.length === 0) continue;

      const consultantJoined = sessions.some((s) =>
        s.attendances.some((a) => a.userId === consultantUserId),
      );
      const consulteeJoined = sessions.some((s) =>
        s.attendances.some((a) => a.userId === consulteeUserId),
      );

      // Conservative definition of a CONSULTANT no-show: the consultee has a
      // recorded join (positive evidence they showed up) AND the consultant has
      // no MeetingAttendance row at all (firstJoinedAt is only ever written on a
      // join, so an absent row means they never arrived). Neither-showed and
      // consultee-no-show cases are intentionally excluded — no consultant-fault
      // refund there.
      if (!consulteeJoined || consultantJoined) continue;

      detected++;
      console.log(`\n🚫 Consultant no-show: consultation ${consultation.id}`);
      console.log(`   Plan: ${consultation.consultationPlan?.title}`);

      // Claim it: CAS active → CANCELLED. This is the idempotency gate — the
      // detection query only reads APPROVED/SCHEDULED, so once flipped a later
      // run (or the auto-complete cron) cannot re-process it. A concurrent
      // cancel landing here wins and this returns 0 → skip.
      const claimed = await prisma.consultation.updateMany({
        where: { id: consultation.id, status: { in: CANCELLABLE_FROM } },
        data: {
          status: AppointmentStatus.CANCELLED,
          cancellationReason: CancellationReason.CONSULTANT_UNAVAILABLE,
          cancellationNotes: "#471 consultant no-show — auto-cancelled + refunded",
          cancelledAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        console.log(`   ⏭️ Skipped — status changed since scan`);
        detected--;
        continue;
      }

      // Reflect the no-show on the slots. No NO_SHOW slot status exists (schema
      // frozen — #471 uses existing values); CANCELLED is the closest. Only move
      // slots the auto-complete cron left SCHEDULED/UNVERIFIED.
      await prisma.slotOfAppointment.updateMany({
        where: {
          appointmentId: consultation.appointment?.id,
          completionStatus: {
            in: [SlotCompletionStatus.SCHEDULED, SlotCompletionStatus.UNVERIFIED],
          },
        },
        data: { completionStatus: SlotCompletionStatus.CANCELLED },
      });

      // Full refund, reusing B1's refundPayment path (#990). Idempotent:
      // refundPayment's refundable-balance guard throws if already refunded, so
      // even a stale re-entry cannot double-refund. On failure we surface for ops
      // (the cancellation stands) rather than silently swallowing — same doctrine
      // as the manual cancel route.
      const paidPayment = consultation.appointment?.payment?.find(
        (p) => p.paymentStatus === PaymentStatus.SUCCEEDED && p.amount > 0n,
      );
      let refundedPaise = 0;
      if (paidPayment) {
        try {
          const r = await refundPayment({
            paymentId: paidPayment.id,
            reason: "consultant no-show (#471)",
            initiatedByUserId: null,
          });
          refundedPaise = r.amountRefundedPaise;
          refunded++;
          console.log(`   💸 Refunded ${refundedPaise}p`);
        } catch (refundErr) {
          const msg = `Failed to refund no-show consultation ${consultation.id} (payment ${paidPayment.id}): ${refundErr}`;
          console.error(`   ❌ ${msg}`);
          errors.push(msg);
        }
      } else {
        const msg = `No refundable payment for no-show consultation ${consultation.id}`;
        console.warn(`   ⚠️ ${msg}`);
        errors.push(msg);
      }

      // Fire-and-forget notifications (non-blocking, reusing the Novu service).
      const consultantName =
        consultation.consultationPlan?.consultantProfile?.user?.name ??
        "Consultant";
      const consulteeName = consultation.requestedBy?.user?.name ?? "Consultee";
      const planTitle = consultation.consultationPlan?.title ?? "Consultation";
      const dashboardUrl = `${getAppUrl()}/dashboard`;

      void notifyAppointmentCancelled(
        [consultantUserId, consulteeUserId],
        {
          appointmentId: consultation.appointment?.id,
          appointmentType: "consultation",
          consultantName,
          consulteeName,
          planTitle,
          dashboardUrl,
          cancelledBy: "system",
          reason: "Consultant did not attend the scheduled session.",
        },
      ).catch((e) =>
        console.error(`[no-show] cancellation notify failed:`, e),
      );

      if (refundedPaise > 0 && paidPayment) {
        void notifyRefundProcessed(consulteeUserId, {
          amount: refundedPaise,
          currency: paidPayment.currency,
          reason: "consultant no-show",
          appointmentType: "consultation",
          consultantName,
          dashboardUrl,
        }).catch((e) =>
          console.error(`[no-show] refund notify failed:`, e),
        );
      }
    } catch (error) {
      const msg = `Failed to handle candidate consultation ${consultation.id}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  // TODO(#471): subscriptions are multi-session — a single-session consultant
  // no-show is a partial refund of one session out of N, not a whole-booking
  // cancel. Deferred pending per-session refund design; consultations (the
  // single-session exclusive case) are handled above.

  console.log("\n📊 No-Show Summary:");
  console.log(`   Detected: ${detected}`);
  console.log(`   Refunded: ${refunded}`);
  if (errors.length > 0) {
    console.log("\n⚠️ Errors:");
    errors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: errors.length === 0,
    detected,
    refunded,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
