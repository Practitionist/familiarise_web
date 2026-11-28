/**
 * #appt-support — build the immutable SupportContext for a thread. Resolved once
 * per turn and passed to whichever resolver (flowchart / AI / human), so none of
 * them re-query or diverge, and a hand-off never loses context.
 */

import prisma from "@/lib/prisma";
import { computeRefundPct } from "@/lib/payments/operations/cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "@/lib/payments/operations/cancellation-policy-store";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { liveOccurrencesOf } from "@/lib/appointments/occurrences";
import { seatOrganizationId } from "@/lib/booking/participants";
import {
  currentSessionHostUserIds,
  SESSION_HOSTS_SELECT,
  sessionHostUserIds,
} from "@/lib/booking/session-hosts";
import type { SupportContext, SupportStage } from "./types";

/**
 * Intents whose subject is a call that ALREADY HAPPENED.
 *
 * The context used to describe the current-or-next session regardless of what
 * was being asked, which is only right for the forward-looking intents. On a
 * subscription holding up to 24 meetings, a no-show reported for last week was
 * answered with next week's session — its stage, its window, its recording
 * eligibility. Reporting a missed call and being told about a call that has not
 * happened yet is the same confusion #1061 caused elsewhere, one level up.
 *
 * Everything absent from this set is either forward-looking (RESCHEDULE,
 * CANCEL_REFUND) or booking-level (PAYMENT_STATUS, DOCUMENTS, the org rails),
 * and for those the current-or-next session is the correct subject.
 */
const USER_ID = { select: { userId: true } } as const;

/** Every period a collaborator held on the team, as the host-side functions read it. */
const HOST_PERIODS =
  SESSION_HOSTS_SELECT.class.select.classPlan.select.collaborators;

const RETROSPECTIVE_CATEGORIES = new Set([
  "NO_SHOW",
  "RECORDING_ACCESS",
  "TECHNICAL",
  "QUALITY_COMPLAINT",
]);

/**
 * Assemble the context for (appointment, user). Returns null if the appointment
 * doesn't exist. Trusts its caller for authz (the user must participate).
 */
export async function buildSupportContext(
  threadId: string,
  appointmentId: string,
  userId: string,
  /**
   * The thread's intent. Decides WHICH session the context is about; omitted
   * callers keep the current-or-next behaviour.
   */
  category?: string | null,
  /** The session the page or turn names; a retrospective intent is about it when it has ended. */
  occurrenceId?: string,
): Promise<SupportContext | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      appointmentType: true,
      organizationId: true,
      cancellationPolicy: POLICY_TERMS_INCLUDE,
      occurrences: {
        // Every live row, not the next one: the retrospective intents need
        // the last finished call as well as the next one (#1554: one row per
        // held call, with its real bounds).
        //
        // Live means "not called off", NOT "still SCHEDULED". A session that has
        // happened is COMPLETED or UNVERIFIED, so the old status equality
        // deleted exactly the rows the retrospective intents are about:
        // `lastEndedRun` was always null, a no-show report fell back to the
        // upcoming session, and with nothing upcoming `endsAt` was null — so the
        // server-side 48-hour recording-window check could not run at all. Same
        // exclusion as `heldOccurrence` (lib/reviews.ts) and `isDeadOccurrence`
        // (lib/appointments/occurrences.ts), which the read below re-applies.
        where: {
          deletedAt: null,
          completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
        },
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          isTentative: true,
          completionStatus: true,
        },
      },
      payment: {
        where: { paymentStatus: "SUCCEEDED", amount: { gt: 0 } },
        select: { id: true, amount: true },
        take: 1,
      },
      consultation: {
        select: {
          consultationPlan: {
            select: { title: true, consultantProfile: USER_ID },
          },
        },
      },
      subscription: {
        select: {
          subscriptionPlan: {
            select: { title: true, consultantProfile: USER_ID },
          },
        },
      },
      // A paid trial's expert is its plan's author, as `sessionHostUserIds` reads it.
      trial: {
        select: {
          subscriptionPlan: { select: { consultantProfile: USER_ID } },
        },
      },
      // #1580 C-P1-3 — an ACCEPTED collaborator is on the provider side too,
      // so they are never offered the attendee no-show flow.
      webinar: {
        select: {
          webinarPlan: {
            select: {
              title: true,
              consultantProfile: USER_ID,
              collaborators: HOST_PERIODS,
            },
          },
        },
      },
      class: {
        select: {
          classPlan: {
            select: {
              title: true,
              consultantProfile: USER_ID,
              collaborators: HOST_PERIODS,
            },
          },
        },
      },
    },
  });
  if (!appt) return null;

  const nowMs = Date.now();
  const runs = liveOccurrencesOf(appt.occurrences).map((row) => ({
    id: row.id,
    startsAt: new Date(row.startsAt),
    endsAt: new Date(row.endsAt),
  }));
  /** The call in progress or still to come — the forward-looking subject. */
  const activeRun = runs.find((run) => run.endsAt.getTime() > nowMs) ?? null;
  /** The most recent call that has finished. */
  const lastEndedRun =
    [...runs].reverse().find((run) => run.endsAt.getTime() <= nowMs) ?? null;
  /** Every call that has finished, newest first: the sessions a report can be about. */
  const endedRuns = runs
    .filter((run) => run.endsAt.getTime() <= nowMs)
    .reverse();
  const namedEnded = occurrenceId
    ? (endedRuns.find((run) => run.id === occurrenceId) ?? null)
    : null;
  // A named session is reportable only once it has ended; otherwise every ended one is.
  let reportSessions = endedRuns;
  if (occurrenceId) reportSessions = namedEnded ? [namedEnded] : [];

  // A retrospective intent is ABOUT the finished call, so that is the session
  // the whole context describes. Everything else keeps the current-or-next
  // session, falling back to the last finished one so a delivered booking
  // still has a real clock for the recording window.
  const subjectRun = RETROSPECTIVE_CATEGORIES.has(category ?? "")
    ? (namedEnded ?? lastEndedRun ?? activeRun)
    : (activeRun ?? lastEndedRun);

  const startsAt = subjectRun?.startsAt ?? null;
  const endsAt: Date | null = subjectRun?.endsAt ?? null;

  // A report on an ended session is judged by the hosts that session had (`sessionHostUserIds`),
  // so its flow reads the same side; anything else is about today's team.
  const reportedRun =
    RETROSPECTIVE_CATEGORIES.has(category ?? "") &&
    subjectRun &&
    subjectRun.endsAt.getTime() <= nowMs
      ? subjectRun
      : null;
  const isProvider = (
    reportedRun
      ? sessionHostUserIds(appt, reportedRun)
      : currentSessionHostUserIds(appt)
  ).includes(userId);

  // Session stage from the slot window. A past slot (or no live slot at all —
  // e.g. a booking whose every row was cancelled away) reads as COMPLETED; a
  // slot whose window contains now is LIVE.
  const now = nowMs;
  const stage: SupportStage = startsAt
    ? endsAt && now >= endsAt.getTime()
      ? "COMPLETED"
      : now >= startsAt.getTime()
        ? "LIVE"
        : "UPCOMING"
    : "COMPLETED";

  // Recordings hang off the slot's meeting session, not the appointment directly
  // (Recording → Meeting → AppointmentOccurrence → Appointment).
  const recording = await prisma.recording.findFirst({
    where: { meeting: { occurrence: { appointmentId } } },
    select: { id: true },
  });

  // Policy refund % if cancelled now (consultee-initiated). Only meaningful when
  // there is a start time to measure notice against; the caller re-derives the real
  // amount at execution time (this is a preview for the flow). #1499 — the guard no
  // longer requires a stored policy: a booking with none is governed by the platform
  // ladder, so the percentage is knowable either way.
  //
  // Measured against the session you would actually be cancelling — the
  // current-or-next one — never the retrospective subject above. A no-show
  // thread must not price a refund off a session that already happened.
  const cancellableFrom = activeRun?.startsAt ?? null;
  let refundPctIfCancelledNow: number | null = null;
  if (cancellableFrom) {
    const hoursUntilStart =
      (cancellableFrom.getTime() - Date.now()) / 3_600_000;
    refundPctIfCancelledNow = computeRefundPct(
      termsFromPolicyRow(appt.cancellationPolicy),
      hoursUntilStart,
      false,
    );
  }

  // Org-operator party: an ACTIVE membership with operations.read on this
  // appointment's org. This is the ONLY org-side elevation in support — it
  // lets an operator open their own org-party thread (dispute intents); it
  // never grants access to anyone else's transcript (ADR 20).
  let isOrgOperator = false;
  if (appt.organizationId) {
    const membership = await prisma.membership.findFirst({
      where: {
        userId,
        organizationId: appt.organizationId,
        status: "ACTIVE",
      },
      select: { role: true },
    });
    isOrgOperator =
      !!membership && hasOrgPermission(membership.role, "operations.read");
  }

  // #1852 — an attendee of a group session talks to support about THEIR
  // seat, which may be B2C or funded by another org than the host.
  const seatOrgId = await seatOrganizationId(prisma, appt, userId);

  return {
    threadId,
    appointmentId: appt.id,
    userId,
    organizationId: seatOrgId,
    appointmentType: appt.appointmentType,
    isOrgContext: seatOrgId !== null,
    isProvider,
    isOrgOperator,
    stage,
    startsAt,
    endsAt,
    reportSessions,
    reportOccurrenceId:
      reportSessions.length === 1 ? reportSessions[0].id : null,
    refundPctIfCancelledNow,
    paymentId: appt.payment[0]?.id ?? null,
    // moneyResultExtensions has already converted the BigInt column → number paise.
    paymentAmountPaise: appt.payment[0]?.amount ?? null,
    hasRecording: !!recording,
    planTitle:
      appt.consultation?.consultationPlan?.title ??
      appt.subscription?.subscriptionPlan?.title ??
      appt.webinar?.webinarPlan?.title ??
      appt.class?.classPlan?.title ??
      null,
  };
}
