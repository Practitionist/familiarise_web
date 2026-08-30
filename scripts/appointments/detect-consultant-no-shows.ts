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

import * as Sentry from "@sentry/nextjs";
import prisma from "../../lib/prisma";
import { getCallPresenceEvidence } from "@/lib/stream/call-presence";
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
import { notificationScope } from "../../lib/novu/workflows";
import { notificationHref } from "../../lib/novu/resolve-href";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { CANCELLABLE_FROM } from "@/lib/booking/transitions";
import { recordSystemError } from "@/lib/enterprise/system-events";

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
  /**
   * Candidates the attendance rows called a no-show and Stream did not.
   *
   * Non-zero means a `call.session_participant_joined` delivery was lost: the
   * consultant WAS in the call and our rows do not know it. Every one of these
   * is a refund that would have been issued wrongly before this check existed.
   */
  contradicted: number;
  errors: string[];
  timestamp: string;
}

export async function detectConsultantNoShows(): Promise<NoShowResult> {
  // #476 — locked at the core so every entry shares one mutual exclusion.
  // Fail-closed: this is a money job (auto-refund), so per with-cron-lock.ts it
  // refuses to run without a real Redis lock rather than risk a silent unlocked
  // double-run. The CAS claim + refundPayment's refundable-balance guard remain
  // the correctness backstop; the lock is the mutual-exclusion layer on top.
  return withCronLock("detect-consultant-no-shows", { failMode: "closed" }, () =>
    detectConsultantNoShowsUnlocked(),
  );
}

// Candidate consultations: still active (not already cancelled/completed),
// paid, whose slots have all ended past the grace window and where a
// MeetingSession actually happened (the call took place — a precondition for
// "the consultee showed up but the consultant didn't").
function findNoShowCandidates(graceCutoff: Date) {
  return prisma.consultation.findMany({
    where: {
      status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
      appointment: {
        payment: {
          some: {
            paymentStatus: PaymentStatus.SUCCEEDED,
            // E2E-audit P1 fix — amount > 0 used to exclude fully
            // credit-funded (free_) bookings, so a consultant no-showing a
            // credits-paid session silently skipped BOTH the cancellation
            // and the credit restoration. The front door routes those to the
            // credits rail on its own.
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
}

type NoShowCandidate = Awaited<ReturnType<typeof findNoShowCandidates>>[number];
type NoShowParty = {
  consultantUserId: string;
  consulteeUserId: string;
  appointmentId: string;
};
type PaidPayment = NonNullable<
  NoShowCandidate["appointment"]
>["payment"][number];

// Returns the party ids when `consultation` is a confirmed CONSULTANT no-show,
// or null to skip. Conservative definition: the consultee has a recorded join
// (positive evidence they showed up) AND the consultant has no MeetingAttendance
// row at all (firstJoinedAt is only ever written on a join, so an absent row
// means they never arrived). Neither-showed and consultee-no-show cases are
// intentionally excluded — no consultant-fault refund there.
function evaluateConsultantNoShow(
  consultation: NoShowCandidate,
): NoShowParty | null {
  const consultantUserId =
    consultation.consultationPlan?.consultantProfile?.userId;
  const consulteeUserId = consultation.requestedBy?.userId;
  const appointmentId = consultation.appointment?.id;
  if (!consultantUserId || !consulteeUserId || !appointmentId) {
    // Cannot attribute presence without both user ids, and an undefined
    // appointmentId would drop the where-filter on the slot updateMany below
    // (Prisma ignores undefined) — skip, don't guess.
    return null;
  }

  // Presence across every session tied to this booking's slots.
  const sessions = (consultation.appointment?.slotsOfAppointment ?? [])
    .map((s) => s.meetingSession)
    .filter((m): m is NonNullable<typeof m> => !!m);
  if (sessions.length === 0) return null;

  const consultantJoined = sessions.some((s) =>
    s.attendances.some((a) => a.userId === consultantUserId),
  );
  const consulteeJoined = sessions.some((s) =>
    s.attendances.some((a) => a.userId === consulteeUserId),
  );

  if (!consulteeJoined || consultantJoined) return null;

  return { consultantUserId, consulteeUserId, appointmentId };
}

/**
 * Does Stream's own record of the call contradict a no-show finding?
 *
 * `evaluateConsultantNoShow` infers absence from a MISSING attendance row, and
 * those rows come from per-participant webhook deliveries that can be lost
 * independently. Losing only the consultant's produces a textbook false
 * positive: consultee present, consultant "absent", full refund against someone
 * who was there.
 *
 * Stream is an independent witness that does not depend on our webhook pipeline
 * having worked. Two distinct participants in a 1:1 consultation means both
 * parties were present, whatever our rows say.
 *
 * Returns the reason to REFUSE, or null to proceed. Refusing on missing evidence
 * is deliberate: this function guards an automatic, customer-visible refund, and
 * "we could not check" is not "it definitely happened". The cost of refusing
 * wrongly is a support ticket; the cost of refunding wrongly is re-charging a
 * customer by hand.
 */
async function refusalFromStreamEvidence(
  consultation: NoShowCandidate,
): Promise<string | null> {
  const callIds = (consultation.appointment?.slotsOfAppointment ?? [])
    .map((slot) => slot.meetingSession?.streamCallId)
    .filter((id): id is string => !!id);

  if (callIds.length === 0) return "no Stream call on any slot";

  for (const callId of callIds) {
    const evidence = await getCallPresenceEvidence(callId);
    if (!evidence) return `Stream has no report for ${callId}`;
    if (evidence.unique >= 2) {
      return `Stream saw ${evidence.unique} distinct participants on ${callId}`;
    }
  }
  return null;
}

// Claim it: CAS active → CANCELLED. This is the idempotency gate — the detection
// query only reads APPROVED/SCHEDULED, so once flipped a later run (or the
// auto-complete cron) cannot re-process it. A concurrent cancel landing here wins
// and this returns false → skip. On a successful claim we also reflect the
// no-show on the slots (no NO_SHOW slot status exists — schema frozen, #471 —
// CANCELLED is the closest; only move slots left SCHEDULED/UNVERIFIED).
async function claimConsultantNoShow(
  consultationId: string,
  appointmentId: string,
): Promise<boolean> {
  const claimed = await prisma.consultation.updateMany({
    where: { id: consultationId, status: { in: CANCELLABLE_FROM } },
    data: {
      status: AppointmentStatus.CANCELLED,
      cancellationReason: CancellationReason.CONSULTANT_UNAVAILABLE,
      cancellationNotes: "#471 consultant no-show — auto-cancelled + refunded",
      cancelledAt: new Date(),
    },
  });
  if (claimed.count === 0) return false;

  await prisma.slotOfAppointment.updateMany({
    where: {
      appointmentId,
      completionStatus: {
        in: [SlotCompletionStatus.SCHEDULED, SlotCompletionStatus.UNVERIFIED],
      },
    },
    data: { completionStatus: SlotCompletionStatus.CANCELLED },
  });
  return true;
}

// Full refund, reusing B1's refundPayment path (#990). Idempotent:
// refundPayment's refundable-balance guard throws if already refunded, so even a
// stale re-entry cannot double-refund. On failure we surface for ops (the
// cancellation stands) rather than silently swallowing. Returns the refunded
// amount, whether refundPayment succeeded, and the payment (for notifications).
async function refundNoShowConsultation(
  consultation: NoShowCandidate,
  errors: string[],
): Promise<{
  refundedPaise: number;
  succeeded: boolean;
  paidPayment: PaidPayment | undefined;
}> {
  const paidPayment = consultation.appointment?.payment?.find(
    (p) => p.paymentStatus === PaymentStatus.SUCCEEDED,
  );
  if (!paidPayment) {
    const msg = `No refundable payment for no-show consultation ${consultation.id}`;
    console.warn(`   ⚠️ ${msg}`);
    errors.push(msg);
    return { refundedPaise: 0, succeeded: false, paidPayment: undefined };
  }
  try {
    // E2E-audit P1 fix — route through the booking front door (doctrine
    // rule 3). Raw refundPayment throws UNKNOWN_GATEWAY on org-funded
    // internal intents (org_wallet_/org_invoice_/org_license_), which used
    // to strand the refund as a PENDING placeholder until the reconcile cron
    // failed it a day later — with the booking already CANCELLED. The front
    // door splits gateway / in-ledger-org / credits rails correctly.
    const r = await refundBookingPayment({
      paymentId: paidPayment.id,
      reason: "consultant no-show (#471)",
      initiatedByUserId: null,
    });
    console.log(`   💸 Refunded ${r.amountRefundedPaise}p via ${r.rail}`);
    return {
      refundedPaise: r.amountRefundedPaise,
      succeeded: true,
      paidPayment,
    };
  } catch (refundErr) {
    const msg = `Failed to refund no-show consultation ${consultation.id} (payment ${paidPayment.id}): ${refundErr}`;
    console.error(`   ❌ ${msg}`);
    errors.push(msg);
    // Ops parity with every other refund-failure path: durable signal, not
    // just this job's stdout.
    void recordSystemError({
      organizationId: null,
      category: "PAYMENT",
      summary: `No-show refund failed for consultation ${consultation.id}`,
      err: refundErr instanceof Error ? refundErr : new Error(String(refundErr)),
      context: { paymentId: paidPayment.id },
    }).catch(() => {});
    return { refundedPaise: 0, succeeded: false, paidPayment };
  }
}

// Fire-and-forget notifications (non-blocking, reusing the Novu service).
function notifyNoShowParties(
  consultation: NoShowCandidate,
  party: NoShowParty,
  refundedPaise: number,
  paidPayment: PaidPayment | undefined,
): void {
  const consultantName =
    consultation.consultationPlan?.consultantProfile?.user?.name ??
    "Consultant";
  const consulteeName = consultation.requestedBy?.user?.name ?? "Consultee";
  const planTitle = consultation.consultationPlan?.title ?? "Consultation";
  const noShowOrgId = consultation.appointment?.organizationId ?? null;
  const dashboardUrl = notificationHref(noShowOrgId, "appointments");

  void notifyAppointmentCancelled(
    [party.consultantUserId, party.consulteeUserId],
    {
      ...notificationScope(noShowOrgId),
      appointmentId: party.appointmentId,
      appointmentType: "consultation",
      consultantName,
      consulteeName,
      planTitle,
      dashboardUrl,
      cancelledBy: "system",
      reason: "Consultant did not attend the scheduled session.",
    },
  ).catch((e) => console.error(`[no-show] cancellation notify failed:`, e));

  if (refundedPaise > 0 && paidPayment) {
    void notifyRefundProcessed(party.consulteeUserId, {
      ...notificationScope(noShowOrgId),
      amount: refundedPaise,
      currency: paidPayment.currency,
      reason: "consultant no-show",
      appointmentType: "consultation",
      consultantName,
      dashboardUrl,
    }).catch((e) => console.error(`[no-show] refund notify failed:`, e));
  }
}

async function detectConsultantNoShowsUnlocked(): Promise<NoShowResult> {
  const errors: string[] = [];
  let detected = 0;
  let refunded = 0;
  let contradicted = 0;

  const graceCutoff = new Date(Date.now() - NO_SHOW_GRACE_MINUTES * 60 * 1000);

  console.log("🔍 Scanning for consultant no-shows...");
  console.log(`   Grace window: ${NO_SHOW_GRACE_MINUTES} min after session end`);

  const candidates = await findNoShowCandidates(graceCutoff);

  console.log(`Found ${candidates.length} paid, ended candidates to check`);

  for (const consultation of candidates) {
    try {
      const party = evaluateConsultantNoShow(consultation);
      if (!party) continue;

      // Corroborate against Stream before moving money. Our attendance rows are
      // webhook-derived and each party's arrives separately, so the predicate
      // above can be satisfied by a LOST DELIVERY rather than a real absence.
      const refusal = await refusalFromStreamEvidence(consultation);
      if (refusal) {
        contradicted++;
        console.log(
          `\n🛑 Not a no-show after all: consultation ${consultation.id} — ${refusal}`,
        );
        // Worth an alert rather than a log line. Either a webhook was lost — in
        // which case attendance data is wrong platform-wide and this is the only
        // place it surfaces — or the detector's own predicate needs revisiting.
        Sentry.captureMessage("Consultant no-show refused on Stream evidence", {
          level: "warning",
          tags: { subsystem: "jobs", job: "detect-consultant-no-shows" },
          extra: { consultationId: consultation.id, refusal },
        });
        continue;
      }

      detected++;
      console.log(`\n🚫 Consultant no-show: consultation ${consultation.id}`);
      console.log(`   Plan: ${consultation.consultationPlan?.title}`);

      const claimed = await claimConsultantNoShow(
        consultation.id,
        party.appointmentId,
      );
      if (!claimed) {
        console.log(`   ⏭️ Skipped — status changed since scan`);
        detected--;
        continue;
      }

      const { refundedPaise, succeeded, paidPayment } =
        await refundNoShowConsultation(consultation, errors);
      if (succeeded) refunded++;

      notifyNoShowParties(consultation, party, refundedPaise, paidPayment);
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
  console.log(`   Refused on Stream evidence: ${contradicted}`);
  if (errors.length > 0) {
    console.log("\n⚠️ Errors:");
    errors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: errors.length === 0,
    detected,
    refunded,
    contradicted,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
