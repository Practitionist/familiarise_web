import { PROFILE_OWNER_SELECT } from "@/lib/booking/list-selects";
import {
  isTooSoonFor,
  RESCHEDULE_MIN_LEAD_HOURS,
} from "@/lib/booking/lead-time";
import * as Sentry from "@sentry/nextjs";
import {
  applyRateLimit,
  eventMutationLimiter,
  rescheduleAppointmentLimiter,
} from "@/lib/rate-limit";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { platformRescheduleGrant } from "@/lib/booking/platform-reschedule";
import type {
  OccurrenceCompletionStatus,
  RescheduleInitiatorRole,
  ReschedulePreferredDays,
  ReschedulePreferredTimeOfDay,
} from "@prisma/client";
import {
  RescheduleProposalSchema,
  RescheduleSlotIdsSchema,
} from "@/schemas/appointments";
import type { Session } from "@/lib/auth";
import { withIdempotency } from "@/lib/api/idempotency";
import {
  autoConfirmRefusalIsFinal,
  autoConfirmTimesTaken,
  computeProposalExpiry,
  proposalCoverageMatches,
  releasedAtomCount,
  rescheduleNotificationVariant,
  rescheduleProposeOutcome,
} from "@/lib/booking/reschedule-proposals";
import {
  ReschedulePolicyError,
  RescheduleAuthorizationError,
  AppointmentTypeMismatchError,
  AppointmentNotFoundError,
} from "@/utils/errors/RescheduleErrors";
import { apiError } from "@/lib/errors/api-error";
import { isRefusal } from "@/lib/errors/refusal";
import { notifyAppointmentRescheduled } from "@/lib/novu/service";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { stageAppointmentRescheduledEmail } from "@/lib/email/senders/booking";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import {
  dropRefusedProposalTimes,
  tryAutoConfirmProposal,
} from "@/lib/booking/reschedule-auto-confirm";
import { withdrawRescheduleRequest } from "@/lib/booking/reschedule-withdraw";
import { hasActiveDisputeForAppointment } from "@/lib/payments/dispute-guard";
import {
  RESCHEDULABLE_FROM,
  SLOT_RESCHEDULABLE_FROM,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { recordActForOrg, resolveOrgActor } from "@/lib/booking/org-actor";
import {
  isSuspendedInFundingOrg,
  membershipSuspendedError,
} from "@/lib/enterprise/suspended-member-sessions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { holdHoursFor } from "@/lib/payments/payouts/earnings-hold";
import {
  MAX_CONSULTEE_RESCHEDULES,
  MAX_EXPERT_RESCHEDULES,
  consulteeCapReached,
  priorReschedules as priorRescheduleCount,
  trialCapReached,
} from "@/lib/booking/reschedule-caps";
import {
  confirmTrialProposal,
  proposedTrialWindow,
  type TrialConfirmOutcome,
} from "@/lib/booking/trial-reschedule";
import type { AppointmentType } from "@/lib/payments/payouts/constants";
import { releasedSessionsOf } from "@/lib/booking/released-sessions";
import {
  RELEASE_ONE_WEEK_MESSAGE,
  spansPlanWeeks,
} from "@/lib/booking/release-weeks";
import { bookingTransaction } from "@/lib/db/booking-transaction";

const RESCHEDULE_REALLOCATION_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;

/** "1 hour 30 minutes" for a duration in whole minutes. */
function durationWords(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [
    ...(hours > 0 ? [`${hours} hour${hours === 1 ? "" : "s"}`] : []),
    ...(rest > 0 ? [`${rest} minutes`] : []),
  ];
  return parts.join(" ") || "0 minutes";
}

/**
 * Which side is asking. Null for a platform operator acting through the
 * back-office door, who is neither party and therefore never auto-confirms on
 * someone else's behalf.
 */
/** A trial moves as one window, so a taken refusal names that window's start. */
function trialTakenStarts(
  outcome: TrialConfirmOutcome,
  proposedSlots: { startsAt: Date; endsAt: Date }[] | undefined,
): string[] {
  if (!outcome.confirmed && outcome.takenSlotStarts?.length) {
    return outcome.takenSlotStarts;
  }
  const window = proposedTrialWindow(proposedSlots ?? []);
  return window ? [window.startsAt.toISOString()] : [];
}

function roleOf(
  isConsultee: boolean,
  isConsultant: boolean,
): RescheduleInitiatorRole | null {
  if (isConsultee) return "CONSULTEE";
  if (isConsultant) return "CONSULTANT";
  return null;
}

/**
 * POST /api/appointments/[appointmentId]/reschedule
 *
 * Releases a consultation, a whole subscription, chosen subscription sessions
 * (`slotIds`) or a trial's one session, and opens the booking's one
 * reschedule request: with
 * `proposedSlots` it is a proposal (a consultee's may auto-confirm), without
 * them it is preference-only ("any time works") and the consultant places the
 * time; a trial always names its one new window and moves once per side.
 * Either way the request expires back to the original time. Webinars
 * re-time and class sessions cancel + make-up instead. No session within 24 h
 * moves, and no new time is within 24 h.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  // A fresh, ban-aware read; the 401 / 403 / 503 shapes are the helper's.
  const authResult = await requireApiAuth({ expectUser: true });
  if (authResult.error) return authResult.error;
  const { session } = authResult;
  const { appointmentId } = await params;
  // A repeated `Idempotency-Key` replays the committed answer instead of
  // releasing the booking a second time.
  return await withIdempotency(
    request,
    {
      scope: `booking.reschedule:${appointmentId}`,
      userId: session.user.id,
    },
    (body) => requestReschedule(request, session, appointmentId, body),
  );
}

async function requestReschedule(
  request: NextRequest,
  session: Session,
  appointmentId: string,
  body: unknown,
): Promise<NextResponse> {
  try {
    // #1319 — this route triggers refunds/reallocation and had no limiter.
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;

    const apptLimited = await applyRateLimit(
      rescheduleAppointmentLimiter,
      `${session.user.id}:${appointmentId}`,
    );
    if (apptLimited) return apptLimited;
    const { searchParams } = new URL(request.url);
    const appointmentType = searchParams.get("type");

    // #1008 — an appointment with a live payment dispute is frozen: its state is
    // evidence and must not move while the dispute is contested.
    if (await hasActiveDisputeForAppointment(appointmentId)) {
      return NextResponse.json(
        {
          error:
            "This appointment has an open payment dispute and can't be rescheduled until it resolves.",
          code: "DISPUTE_ACTIVE",
        },
        { status: 409 },
      );
    }

    // Parse request body for optional slotIds (used for individual/multiple session reschedule)
    let slotIds: string[] | undefined;
    // Concrete replacement times. Optional: "release these, any time works" is
    // still a valid request and remains the whole contract for group events.
    let proposedSlots: { startsAt: Date; endsAt: Date }[] | undefined;
    let reason: string | undefined;
    // #1065 — how the initiator wants the replacement placed when they name no
    // time. Scored by the allocator, never used to exclude a candidate.
    let preferredTimeOfDay: ReschedulePreferredTimeOfDay | undefined;
    let preferredDays: ReschedulePreferredDays | undefined;
    {
      const fields = RescheduleSlotIdsSchema.safeParse(body ?? {});
      // A malformed session list must never widen into a whole-booking release.
      if (!fields.success) {
        return NextResponse.json(
          {
            error: "Invalid sessions to reschedule",
            code: "INVALID_SLOT_IDS",
            details: fields.error.flatten(),
          },
          { status: 400 },
        );
      }
      // Support both single slotId (legacy) and slotIds array
      if (fields.data.slotIds) {
        slotIds = fields.data.slotIds;
      } else if (fields.data.slotId) {
        // Legacy support: convert single slotId to array
        slotIds = [fields.data.slotId];
      }
      const parsedProposal = RescheduleProposalSchema.safeParse(body ?? {});
      if (!parsedProposal.success) {
        return NextResponse.json(
          {
            error: "Invalid proposed times",
            code: "INVALID_PROPOSAL",
            details: parsedProposal.error.flatten(),
          },
          { status: 400 },
        );
      }
      if (parsedProposal.data.proposedSlots?.length) {
        proposedSlots = parsedProposal.data.proposedSlots.map((s) => ({
          startsAt: new Date(s.startsAt),
          endsAt: new Date(s.endsAt),
        }));
      }
      reason = parsedProposal.data.reason;
      preferredTimeOfDay = parsedProposal.data.preferredTimeOfDay;
      preferredDays = parsedProposal.data.preferredDays;
    }

    // #1166 — resolve the funding org's admin membership BEFORE the interactive
    // transaction opens. `isOrgAdminOfAppointment` runs on the global client, so
    // calling it from inside the callback issues a query on a SECOND pooled
    // connection while this transaction is already holding one — the exact
    // shape #908 documents (below, on the auto-confirm check) as having 500'd
    // with "Unable to start a transaction in the given time". A membership row
    // is not transaction state, so reading it early costs nothing.
    const orgScope = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        organizationId: true,
        consultationId: true,
        subscriptionId: true,
        consultation: {
          select: { consultationPlan: { select: { organizationId: true } } },
        },
        subscription: {
          select: { subscriptionPlan: { select: { organizationId: true } } },
        },
        webinar: {
          select: { webinarPlan: { select: { organizationId: true } } },
        },
        class: {
          select: { classPlan: { select: { organizationId: true } } },
        },
        trial: {
          select: { subscriptionPlan: { select: { organizationId: true } } },
        },
      },
    });
    const hostOrgId =
      orgScope?.webinar?.webinarPlan?.organizationId ??
      orgScope?.class?.classPlan?.organizationId ??
      orgScope?.consultation?.consultationPlan?.organizationId ??
      orgScope?.subscription?.subscriptionPlan?.organizationId ??
      orgScope?.trial?.subscriptionPlan?.organizationId ??
      null;
    const hostOrgMembership = hostOrgId
      ? await prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: session.user.id,
              organizationId: hostOrgId,
            },
          },
          select: {
            status: true,
            role: true,
            organization: { select: { status: true } },
          },
        })
      : null;
    const isHostOrgOperator =
      hostOrgMembership?.status === "ACTIVE" &&
      hostOrgMembership.organization.status !== "DEACTIVATED" &&
      hasOrgPermission(hostOrgMembership.role, "catalog.manage");
    const fundingOrgActor = orgScope
      ? await resolveOrgActor(session.user.id, orgScope, "reschedule")
      : null;
    const actorSuspendedInFundingOrg = await isSuspendedInFundingOrg(
      session.user.id,
      orgScope?.organizationId,
    );

    const result = await withAppointmentLock(appointmentId, () =>
      bookingTransaction(
        async (tx) => {
          const appointment = await tx.appointment.findUnique({
            where: { id: appointmentId },
            include: {
              occurrences: {
                orderBy: { startsAt: "asc" },
              },
              consultation: {
                include: {
                  consultationPlan: {
                    include: {
                      consultantProfile: PROFILE_OWNER_SELECT,
                    },
                  },
                  requestedBy: true,
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: {
                    include: {
                      consultantProfile: PROFILE_OWNER_SELECT,
                    },
                  },
                  requestedBy: true,
                },
              },
              webinar: {
                include: {
                  webinarPlan: true,
                },
              },
              class: {
                include: {
                  classPlan: true,
                },
              },
              trial: {
                select: {
                  id: true,
                  status: true,
                  consultantProfileId: true,
                  consulteeProfileId: true,
                },
              },
            },
          });

          if (!appointment) {
            throw new AppointmentNotFoundError("appointment", appointmentId);
          }

          const consultantProfileId = session.user.consultantProfileId;
          const consulteeProfileId = session.user.consulteeProfileId;

          let isParticipant = false;
          let initiatorRole: RescheduleInitiatorRole | null = null;

          if (appointment.consultation) {
            const consultationConsultantId =
              appointment.consultation.consultationPlan?.consultantProfileId;
            const isConsultant =
              (Boolean(consultantProfileId) &&
                consultantProfileId === consultationConsultantId) ||
              isHostOrgOperator;
            const isConsultee =
              Boolean(consulteeProfileId) &&
              consulteeProfileId === appointment.consultation.requestedById;
            isParticipant = isConsultant || isConsultee;
            initiatorRole = roleOf(isConsultee, isConsultant);
          } else if (appointment.subscription) {
            const subscriptionConsultantId =
              appointment.subscription.subscriptionPlan?.consultantProfileId;
            const isConsultant =
              (Boolean(consultantProfileId) &&
                consultantProfileId === subscriptionConsultantId) ||
              isHostOrgOperator;
            const isConsultee =
              Boolean(consulteeProfileId) &&
              consulteeProfileId === appointment.subscription.requestedById;
            isParticipant = isConsultant || isConsultee;
            initiatorRole = roleOf(isConsultee, isConsultant);
          } else if (appointment.webinar) {
            const webinarConsultantId =
              appointment.webinar.webinarPlan?.consultantProfileId;
            isParticipant =
              (Boolean(consultantProfileId) &&
                consultantProfileId === webinarConsultantId) ||
              isHostOrgOperator;
          } else if (appointment.class) {
            const classConsultantId =
              appointment.class.classPlan?.consultantProfileId;
            isParticipant =
              (Boolean(consultantProfileId) &&
                consultantProfileId === classConsultantId) ||
              isHostOrgOperator;
          } else if (appointment.trial) {
            // Only the trial's own two parties move it, as only they can
            // answer the move or cancel the trial.
            const isConsultant =
              Boolean(consultantProfileId) &&
              consultantProfileId === appointment.trial.consultantProfileId;
            const isConsultee =
              Boolean(consulteeProfileId) &&
              consulteeProfileId === appointment.trial.consulteeProfileId;
            isParticipant = isConsultant || isConsultee;
            initiatorRole = roleOf(isConsultee, isConsultant);
            if (!initiatorRole) {
              throw Object.assign(
                new Error(
                  "Only the trial's expert or learner can move it. Cancel it from the back office instead.",
                ),
                { httpStatus: 403, code: "TRIAL_PARTY_ONLY" },
              );
            }
          }

          const isPrivilegedUser = isPrivileged(session.user.role);

          // A platform operator who is not a party reschedules only through the
          // audited back-office door, which grants this request.
          if (
            isPrivilegedUser &&
            !isParticipant &&
            !platformRescheduleGrant(request)
          ) {
            throw Object.assign(
              new Error(
                "Reschedule this booking from the back office so the change is audited.",
              ),
              { httpStatus: 403, code: "PLATFORM_RESCHEDULE_DOOR_REQUIRED" },
            );
          }

          const isOrgAdminActor =
            !isParticipant && !isPrivilegedUser && fundingOrgActor !== null;
          if (isOrgAdminActor) {
            initiatorRole = "CONSULTEE";
          }

          if (!isParticipant && !isPrivilegedUser && !isOrgAdminActor) {
            throw new RescheduleAuthorizationError();
          }
          if (
            initiatorRole === "CONSULTEE" &&
            !isOrgAdminActor &&
            !isPrivilegedUser &&
            actorSuspendedInFundingOrg
          ) {
            throw membershipSuspendedError();
          }

          // Derive type from DB instead of trusting query param
          const derivedType = appointment.consultation
            ? "CONSULTATION"
            : appointment.subscription
              ? "SUBSCRIPTION"
              : appointment.webinar
                ? "WEBINAR"
                : appointment.class
                  ? "CLASS"
                  : appointment.trial
                    ? "TRIAL"
                    : null;

          if (
            appointmentType &&
            derivedType &&
            appointmentType !== derivedType
          ) {
            throw new AppointmentTypeMismatchError(
              appointmentType,
              derivedType,
            );
          }

          // A group event moves to a concrete new date (webinar re-time) or one
          // session at a time (class cancel + make-up); it is never left undated.
          if (derivedType === "WEBINAR") {
            throw Object.assign(
              new Error(
                'Pick the webinar\'s new date with "Move to a new date" instead.',
              ),
              { httpStatus: 400, code: "USE_RETIME" },
            );
          }
          if (derivedType === "CLASS") {
            throw Object.assign(
              new Error(
                "Move a class session by cancelling it and scheduling a make-up.",
              ),
              { httpStatus: 400, code: "USE_SESSION_CANCEL" },
            );
          }

          // A trial has no allocator to place it later, so it always moves to
          // a named window; the confirm checks the length.
          const isTrial = derivedType === "TRIAL";
          if (isTrial && !proposedSlots?.length) {
            throw Object.assign(new Error("Pick the new time for the trial."), {
              httpStatus: 400,
              code: "PROPOSAL_REQUIRED",
            });
          }

          // A party releases only confirmed sessions; a parked or cancelled
          // row waits for the expert to place a new time.
          const releasableFrom: OccurrenceCompletionStatus[] = initiatorRole
            ? ["SCHEDULED"]
            : SLOT_RESCHEDULABLE_FROM;
          // The live set: a requested-but-completed id reports as missing, and
          // the 24-hour gate never reads a past session.
          const liveOccurrences = appointment.occurrences.filter((s) =>
            (releasableFrom as string[]).includes(s.completionStatus),
          );
          const isPerSessionReschedule =
            derivedType === "SUBSCRIPTION" &&
            Boolean(slotIds && slotIds.length > 0);
          const slotsToReschedule = isPerSessionReschedule
            ? liveOccurrences.filter((s) => slotIds?.includes(s.id))
            : liveOccurrences;
          if (isPerSessionReschedule && slotIds) {
            if (slotsToReschedule.length !== slotIds.length) {
              const foundIds = slotsToReschedule.map((s) => s.id);
              const missingIds = slotIds.filter((id) => !foundIds.includes(id));
              throw new AppointmentNotFoundError("slot", missingIds.join(", "));
            }
          }

          const now = new Date();
          for (const slot of slotsToReschedule) {
            const startMs = new Date(slot.startsAt).getTime();
            const hoursUntilSlot = (startMs - now.getTime()) / (1000 * 60 * 60);
            if (
              isTooSoonFor(
                "reschedule",
                { settled: true },
                startMs,
                now.getTime(),
              )
            ) {
              throw new ReschedulePolicyError(
                hoursUntilSlot,
                RESCHEDULE_MIN_LEAD_HOURS,
              );
            }
          }
          if (
            proposedSlots?.some((s) =>
              isTooSoonFor(
                "reschedule",
                { settled: true },
                s.startsAt.getTime(),
                now.getTime(),
              ),
            )
          ) {
            throw Object.assign(
              new Error(
                `New times must be at least ${RESCHEDULE_MIN_LEAD_HOURS} hours away.`,
              ),
              { httpStatus: 400, code: "PROPOSAL_TOO_SOON" },
            );
          }

          // A released batch is re-placed into one plan week, so a release
          // across two weeks is refused before any confirmed time moves.
          const plan = appointment.subscription?.subscriptionPlan;
          if (
            appointment.subscription &&
            plan &&
            spansPlanWeeks(
              {
                sessionsPerWeek: plan.sessionsPerWeek,
                durationInMonths: plan.durationInMonths,
                schedulingPeriodStartsAt:
                  appointment.subscription.schedulingPeriodStartsAt,
                schedulingTimezone: appointment.subscription.schedulingTimezone,
              },
              slotsToReschedule.map((s) => s.startsAt),
            )
          ) {
            throw Object.assign(new Error(RELEASE_ONE_WEEK_MESSAGE), {
              httpStatus: 409,
              code: "RELEASE_ONE_WEEK",
            });
          }

          // One open reschedule per booking: a second release (a double
          // submit, the other side, a second tab) waits for the first to end.
          const alreadyOpen = await tx.rescheduleRequest.findFirst({
            where: { openForAppointmentId: appointmentId },
            select: { id: true },
          });
          if (alreadyOpen) {
            throw Object.assign(
              new Error(
                "A reschedule request is already open for this booking.",
              ),
              { httpStatus: 409, code: "RESCHEDULE_ALREADY_OPEN" },
            );
          }

          // The parent's status as read under the lock: the CAS below is
          // pinned to it and the request records it, so a restore puts back
          // exactly what this release moved.
          const parentStatus =
            appointment.consultation?.status ??
            appointment.subscription?.status ??
            appointment.trial?.status ??
            null;
          const parentMovable = isTrial
            ? parentStatus === "SCHEDULED"
            : RESCHEDULABLE_FROM.some((status) => status === parentStatus);
          if (!parentStatus || !parentMovable) {
            throw Object.assign(
              new Error(
                "This appointment can no longer be rescheduled (already cancelled or completed).",
              ),
              { httpStatus: 409, code: "NOT_RESCHEDULABLE" },
            );
          }
          // A booking holding its time on a live, unexpired payment moves only
          // once it is paid or cancelled, so no capture lands on a moved booking.
          const livePayLinks = await tx.payment.count({
            where: {
              appointmentId,
              paymentStatus: "PENDING",
              deletedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
          });
          if (livePayLinks > 0) {
            throw Object.assign(
              new Error(
                "This booking is still waiting for payment. Pay for it or cancel it first, then reschedule.",
              ),
              { httpStatus: 409, code: "PAY_LINK_LIVE" },
            );
          }

          if (isTrial && initiatorRole && !isPrivilegedUser) {
            const prior = await priorRescheduleCount(tx, {
              appointmentId,
              role: initiatorRole,
            });
            if (trialCapReached(prior)) {
              throw initiatorRole === "CONSULTANT"
                ? Object.assign(
                    new Error(
                      "You've already moved this trial once. If the time no longer works, cancel it — the learner gets a full refund.",
                    ),
                    { httpStatus: 409, code: "EXPERT_RESCHEDULE_CAP" },
                  )
                : Object.assign(
                    new Error(
                      "You can move a trial once. If this time doesn't work either, cancel the trial.",
                    ),
                    { httpStatus: 422, code: "MAX_RESCHEDULES_EXCEEDED" },
                  );
            }
          } else if (initiatorRole && !isPrivilegedUser) {
            const prior = await priorRescheduleCount(tx, {
              appointmentId,
              role: initiatorRole,
            });
            if (
              initiatorRole === "CONSULTANT" &&
              prior.total >= MAX_EXPERT_RESCHEDULES
            ) {
              throw Object.assign(
                new Error(
                  `You've already rescheduled this booking ${MAX_EXPERT_RESCHEDULES} times. ` +
                    "If the time no longer works, cancel instead — the client gets a full refund.",
                ),
                { httpStatus: 409, code: "EXPERT_RESCHEDULE_CAP" },
              );
            }
            if (
              initiatorRole === "CONSULTEE" &&
              consulteeCapReached(
                prior,
                slotsToReschedule.map((s) => s.ordinal),
              )
            ) {
              throw Object.assign(
                new Error(
                  `You can move each session at most ${MAX_CONSULTEE_RESCHEDULES} times.`,
                ),
                { httpStatus: 422, code: "MAX_RESCHEDULES_EXCEEDED" },
              );
            }
          }

          // #1851 decision 2 — the org's own trail, beside the booking's.
          if (isOrgAdminActor && fundingOrgActor) {
            await recordActForOrg(tx, {
              actor: fundingOrgActor,
              action: "reschedule",
              appointmentId,
              reason,
            });
          }

          // Audit attribution for every BookingStatusHistory row this
          // reschedule writes (#1322 A12).
          const auditMeta = {
            actorUserId: session.user.id,
            reason: reason ?? null,
            organizationId: appointment.organizationId,
            at: new Date(),
          };
          // Every slot flip releases the row in place: RESCHEDULED plus
          // tentative, never a tombstone, because the request's
          // releasedOccurrenceIds point at them and a restore flips them back.
          // `allowZero` keeps a release that matches no live row a 200 with
          // `slotsAffected: 0` on a booking with no sessions yet.
          const slotsMoved = await transitionOccurrenceCompletion(tx, {
            ...auditMeta,
            where: isPerSessionReschedule
              ? {
                  appointmentId,
                  id: { in: slotsToReschedule.map((s) => s.id) },
                }
              : { appointmentId },
            to: "RESCHEDULED",
            data: { isTentative: true },
            fromIn: releasableFrom,
            allowZero: true,
          });

          // Reject rescheduling bookings whose allocated slots all reached terminal status before lock.
          if (appointment.occurrences.length > 0 && slotsMoved === 0) {
            throw Object.assign(
              new Error(
                "There's no session left to move on this booking. Message the other party or contact support to agree a new time.",
              ),
              { httpStatus: 409, code: "NO_RESCHEDULABLE_SLOTS" },
            );
          }

          if (slotsToReschedule.length > 0) {
            const holdHours = holdHoursFor(
              (derivedType ??
                appointment.appointmentType ??
                "CONSULTATION") as AppointmentType,
            );
            const maxReleasedEnd = slotsToReschedule.reduce(
              (max, s) => Math.max(max, new Date(s.endsAt).getTime()),
              now.getTime(),
            );
            const maxProposedEnd = (proposedSlots ?? []).reduce(
              (max, s) => Math.max(max, s.endsAt.getTime()),
              0,
            );
            const anchorMs = Math.max(
              maxReleasedEnd + RESCHEDULE_REALLOCATION_BUFFER_MS,
              maxProposedEnd,
            );
            const rescheduledHoldUntil = new Date(
              anchorMs + holdHours * 60 * 60 * 1000,
            );
            const pendingEarningsWhere = {
              status: "PENDING" as const,
              holdUntil: { not: null, lt: rescheduledHoldUntil },
              payment: { appointmentId },
            };
            await tx.consultantEarnings?.updateMany?.({
              where: pendingEarningsWhere,
              data: { holdUntil: rescheduledHoldUntil },
            });
            await tx.organizationEarnings?.updateMany?.({
              where: pendingEarningsWhere,
              data: { holdUntil: rescheduledHoldUntil },
            });
          }

          // Through the CAS helpers, pinned to the status read above: a
          // capture or sweep that moved the parent since makes this a 409
          // instead of recording the wrong origin.
          try {
            if (appointment.trial) {
              // The trial stays SCHEDULED while its session is moved; a
              // locking touch keeps a lockless sweep from ending it under us.
              const live = await tx.trial.updateMany({
                where: { id: appointment.trial.id, status: "SCHEDULED" },
                data: { updatedAt: new Date() },
              });
              if (live.count === 0) {
                throw new IllegalTransitionError("Trial", "SCHEDULED");
              }
            } else if (appointment.consultation) {
              await transitionConsultationRequest(tx, {
                ...auditMeta,
                appointmentId,
                where: { id: appointment.consultation.id },
                to: "PENDING",
                // The stale-request sweep keys its PENDING cohort on
                // requestedAt, so re-entering PENDING refreshes the clock.
                data: { requestedAt: new Date() },
                fromIn: [appointment.consultation.status],
              });
            } else if (appointment.subscription) {
              // #448 — a per-session reschedule leaves the subscription's
              // status alone (the sessions carry RESCHEDULED); only a
              // whole-plan release re-enters PENDING.
              if (isPerSessionReschedule) {
                // #1583 A-P0-03 — a locking touch, not a count: the UPDATE
                // holds the parent row lock until commit, so a lockless sweep
                // cannot terminalise it between this check and the commit.
                const live = await tx.subscription.updateMany({
                  where: {
                    id: appointment.subscription.id,
                    status: appointment.subscription.status,
                  },
                  data: { updatedAt: new Date() },
                });
                if (live.count === 0) {
                  throw new IllegalTransitionError("Subscription", "PENDING");
                }
              } else {
                await transitionSubscriptionRequest(tx, {
                  ...auditMeta,
                  appointmentId,
                  where: { id: appointment.subscription.id },
                  to: "PENDING",
                  data: { requestedAt: new Date() },
                  fromIn: [appointment.subscription.status],
                });
              }
            }
          } catch (err) {
            if (!(err instanceof IllegalTransitionError)) throw err;
            throw Object.assign(
              new Error(
                "This appointment can no longer be rescheduled (already cancelled or completed).",
              ),
              { httpStatus: 409, code: "NOT_RESCHEDULABLE" },
            );
          }

          // Every party release opens a request, times or not: it holds the
          // one-open reservation, gives the initiator Withdraw and the booking
          // an expiry that restores it. With no times it is preference-only,
          // and the allocator closes it when it places the replacement.
          let rescheduleRequestId: string | null = null;
          // #1653 — the deadline the PROPOSED email names; null when no
          // concrete times were sent.
          let proposalExpiresAt: Date | null = null;
          if (initiatorRole) {
            if (slotsToReschedule.length === 0) {
              throw Object.assign(
                new Error(
                  "There's no session to move on this booking yet. Message the other party or contact support to agree a time.",
                ),
                { httpStatus: 409, code: "NO_RESCHEDULABLE_SLOTS" },
              );
            }
            // Atoms on both sides, not rows: a released row is a whole session
            // and a proposed row is one 30-minute atom, the allocator's rule.
            if (
              proposedSlots?.length &&
              !proposalCoverageMatches(slotsToReschedule, proposedSlots)
            ) {
              throw Object.assign(
                new Error(
                  `Pick ${durationWords(releasedAtomCount(slotsToReschedule) * 30)} of new time in total — the same length as what you're moving.`,
                ),
                { httpStatus: 400, code: "PROPOSAL_COUNT_MISMATCH" },
              );
            }

            const expiresAt = computeProposalExpiry(
              slotsToReschedule.map((s) => new Date(s.startsAt)),
            );
            if (!expiresAt) {
              // The 24-hour policy gate above should already have rejected this,
              // so reaching here means the two rules have drifted apart.
              throw Object.assign(
                new Error(
                  "This session is too close to propose a new time for.",
                ),
                { httpStatus: 400, code: "PROPOSAL_WINDOW_CLOSED" },
              );
            }

            const created = await tx.rescheduleRequest.create({
              data: {
                appointmentId,
                initiatorRole,
                initiatedById: session.user.id,
                reason,
                releasedOccurrenceIds: slotsToReschedule.map((s) => s.id),
                releasedSessions: releasedSessionsOf(slotsToReschedule),
                originStatus: parentStatus,
                expiresAt,
                // The nullable @unique backs the pre-check above at the DB.
                openForAppointmentId: appointmentId,
                organizationId: appointment.organizationId ?? null,
                preferredTimeOfDay,
                preferredDays,
                proposedTimes: {
                  create: (proposedSlots ?? []).map((s) => ({
                    startsAt: s.startsAt,
                    endsAt: s.endsAt,
                    proposedById: session.user.id,
                  })),
                },
              },
              select: { id: true },
            });
            // Only a request carrying times can auto-confirm or be answered;
            // the caller reads this id as "times were sent".
            if (proposedSlots?.length) {
              rescheduleRequestId = created.id;
              proposalExpiresAt = expiresAt;
            }
          }

          // #448 / #1554 — one occurrence row is one session, so the count
          // is the number of rows released.
          const sessionsAffected = slotsToReschedule.length;

          // Determine reschedule type for response — session-based (#448)
          const rescheduleType = !isPerSessionReschedule
            ? "entire_booking"
            : sessionsAffected === 1
              ? "individual_session"
              : "multiple_sessions";

          // Captured here because an auto-confirm deletes these rows and writes
          // new ones — by the time the notification is built, the time being
          // given up no longer exists anywhere.
          const releasedAt = slotsToReschedule.reduce<Date | null>(
            (earliest, slot) =>
              !earliest || slot.startsAt < earliest ? slot.startsAt : earliest,
            null,
          );

          // Return detailed response
          return {
            success: true,
            rescheduleType,
            releasedAt,
            // #448 — sessionsAffected is the user-facing count (distinct sessions);
            // slotsAffected stays for back-compat / debugging.
            sessionsAffected,
            slotsAffected: slotsToReschedule.length,
            // Slots that actually moved; below requested when some were
            // already terminal (COMPLETED/CANCELLED) and left live.
            slotsMoved,
            message:
              rescheduleType === "entire_booking"
                ? "All sessions marked for rescheduling. Please select new times."
                : `${sessionsAffected} session(s) marked for rescheduling. Please select new time(s).`,
            // The parent ids the post-commit proposal read needs; appointment is only in scope here.
            logContext: {
              consultationId: appointment.consultation?.id,
              subscriptionId: appointment.subscription?.id,
              trialId: appointment.trial?.id,
            },
            rescheduleRequestId,
            proposalExpiresAt,
          };
        },
        {
          timeout: 60000, // 60 second timeout for complex transactions
        },
      ),
    );

    // A consultee's proposal that lands in published availability and finds both
    // calendars free needs no approval, so take it now. Deliberately AFTER the
    // transaction: validating inside it would pin a pooled connection through
    // the whole availability check, which is the shape #908 documents as having
    // 500'd with "Unable to start a transaction in the given time".
    //
    // Failure here is an ordinary outcome, not an error: a transient one leaves
    // the proposal for the consultant to answer, and a refusal of the times
    // themselves drops them so the consultant places the session instead.
    let autoConfirmed = false;
    let timesStillOffered = Boolean(result.rescheduleRequestId);
    // #FAMILIARISE_WEB-2W — the refusal reason used to be discarded, which
    // made a green-slot auto-confirm failure undiagnosable from the response.
    let autoConfirmReason: string | null = null;
    if (result.rescheduleRequestId && result.logContext.trialId) {
      // A trial has no allocator: the proposal confirms in place or not at all,
      // and a time that cannot be confirmed is never left on a released trial.
      const outcome = await confirmTrialProposal({
        rescheduleRequestId: result.rescheduleRequestId,
        to: "AUTO_ACCEPTED",
      });
      autoConfirmed = outcome.confirmed;
      autoConfirmReason = outcome.confirmed ? null : outcome.reason;
      const taken = autoConfirmTimesTaken(autoConfirmReason);
      if (taken || autoConfirmRefusalIsFinal(autoConfirmReason)) {
        const undone = await withdrawRescheduleRequest({
          rescheduleRequestId: result.rescheduleRequestId,
          withdrawnById: session.user.id,
          notify: false,
        });
        if (undone.withdrawn) {
          return NextResponse.json(
            taken
              ? {
                  error:
                    "That time was just taken. Your trial keeps its original time — pick another time.",
                  code: "TIMES_TAKEN",
                  takenSlotStarts: trialTakenStarts(outcome, proposedSlots),
                }
              : {
                  error:
                    "That time can't be booked: it isn't in the expert's open hours or it's too soon. Your trial keeps its original time — pick another time.",
                  code: "TIME_NOT_BOOKABLE",
                  reason: autoConfirmReason,
                },
            { status: 409 },
          );
        }
      }
    } else if (result.rescheduleRequestId) {
      // Only the two 1:1 kinds carry proposals; a group event never opens one.
      const proposal = result.logContext.consultationId
        ? {
            type: "consultation" as const,
            id: result.logContext.consultationId,
          }
        : null;
      const proposalTarget =
        proposal ??
        (result.logContext.subscriptionId
          ? {
              type: "subscription" as const,
              id: result.logContext.subscriptionId,
            }
          : null);

      if (proposalTarget) {
        try {
          const outcome = await tryAutoConfirmProposal(
            result.rescheduleRequestId,
            proposalTarget.type,
            proposalTarget.id,
          );
          autoConfirmed = outcome.confirmed;
          autoConfirmReason = outcome.confirmed ? null : outcome.reason;
          // Someone took those times a moment ago: put the booking back and
          // let the consultee pick again rather than leave a dead proposal.
          if (!outcome.confirmed && autoConfirmTimesTaken(outcome.reason)) {
            const undone = await withdrawRescheduleRequest({
              rescheduleRequestId: result.rescheduleRequestId,
              withdrawnById: session.user.id,
              notify: false,
            });
            if (undone.withdrawn) {
              return NextResponse.json(
                {
                  error:
                    "Some of the times you picked were just taken. Your booking keeps its original time — pick another time.",
                  code: "TIMES_TAKEN",
                  takenSlotStarts: outcome.takenSlotStarts ?? [],
                },
                { status: 409 },
              );
            }
          }
          if (autoConfirmRefusalIsFinal(autoConfirmReason)) {
            await dropRefusedProposalTimes(result.rescheduleRequestId);
            timesStillOffered = false;
          }
        } catch (err) {
          // A lost AUTO_ACCEPTED race comes back as a reason, never a throw.
          autoConfirmReason = "ERROR";
          Sentry.captureException(
            err instanceof Error ? err : new Error(String(err)),
            {
              tags: { subsystem: "bookings", op: "reschedule-auto-confirm" },
            },
          );
        }
        console.info(
          JSON.stringify({
            event: "reschedule_auto_confirm",
            appointmentId,
            rescheduleRequestId: result.rescheduleRequestId,
            confirmed: autoConfirmed,
            reason: autoConfirmReason,
          }),
        );
      }
    }

    // Fire-and-forget: notify both parties about reschedule
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          consultation: {
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
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
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
            },
          },
          trial: {
            select: {
              subscriptionPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { userId: true, user: { select: { name: true } } },
                  },
                },
              },
              consulteeProfile: {
                select: { userId: true, user: { select: { name: true } } },
              },
            },
          },
        },
      });

      if (appointment) {
        const consultation = appointment.consultation;
        const subscription = appointment.subscription;
        const trial = appointment.trial;

        const plan =
          consultation?.consultationPlan ??
          subscription?.subscriptionPlan ??
          trial?.subscriptionPlan ??
          null;
        const requestedBy =
          consultation?.requestedBy ??
          subscription?.requestedBy ??
          trial?.consulteeProfile ??
          null;

        const userIds: string[] = [];
        if (plan?.consultantProfile?.userId) {
          userIds.push(plan.consultantProfile.userId);
        }
        if (requestedBy?.userId) {
          userIds.push(requestedBy.userId);
        }

        // Deduplicate; exclude the initiator — you don't need a notification
        // about your own reschedule (B15).
        const uniqueUserIds = Array.from(new Set(userIds)).filter(
          (id) => id !== session.user.id,
        );

        const appointmentType = consultation
          ? "consultation"
          : trial
            ? "trial"
            : "subscription";

        // Earliest of the times asked for, while they are still on offer.
        const proposedAt =
          timesStillOffered || autoConfirmed
            ? (proposedSlots?.reduce<Date | null>(
                (earliest, slot) =>
                  !earliest || slot.startsAt < earliest
                    ? slot.startsAt
                    : earliest,
                null,
              ) ?? null)
            : null;

        if (uniqueUserIds.length > 0) {
          const variant = rescheduleNotificationVariant({
            releasedAt: result.releasedAt,
            proposedAt,
            autoConfirmed,
          });
          const dashboardUrl = notificationHref(
            appointment.organizationId,
            "appointments",
          );
          const [bellResults, emailRows] = await Promise.all([
            notifyAppointmentRescheduled(
              uniqueUserIds,
              {
                ...notificationScope(appointment.organizationId),
                ...variant,
                appointmentType,
                consultantName:
                  plan?.consultantProfile?.user?.name ?? "Consultant",
                consulteeName: requestedBy?.user?.name ?? "Participant",
                planTitle: planTitleOrSessionLabel(
                  plan?.title,
                  appointmentType,
                ),
                dashboardUrl,
              },
              { deferAttempt: true },
            ).catch((err) => {
              console.error("[reschedule] Failed to send notification:", err);
              return [];
            }),
            stageAppointmentRescheduledEmail(prisma, {
              appointmentId,
              userIds: uniqueUserIds,
              outcome: variant.outcome,
              appointmentType,
              oldStartsAt: result.releasedAt,
              newStartsAt: proposedAt,
              proposedBy: session.user.name || undefined,
              respondBy: result.proposalExpiresAt,
              dashboardUrl,
            }).catch(() => []),
          ]);
          await flushNotificationsAfter(
            {
              bells: (bellResults ?? []).map((r) => r?.staged),
              emails: [
                { rows: emailRows, emailType: "APPOINTMENT_RESCHEDULED" },
              ],
            },
            "reschedule-route",
          );
        }
      }
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "appointments" } },
      );
      console.error("[reschedule] Failed to send notification:", error);
    }

    // The outcomes read very differently to a user — you're moved, we've asked,
    // we could not place that time, or nothing was proposed — and the previous
    // two-branch version answered "sent to the consultant" for every one of
    // them, asserting a cause the server had just detected was something else.
    // The policy module owns the mapping so the code and the sentence cannot
    // disagree.
    const outcome = rescheduleProposeOutcome({
      autoConfirmed,
      hasProposal: Boolean(result.rescheduleRequestId),
      autoConfirmReason,
      releaseMessage: result.message,
    });

    return NextResponse.json({
      ...result,
      autoConfirmed,
      // #FAMILIARISE_WEB-2W — the refusal reason travels with the outcome so
      // a green-slot auto-confirm failure is diagnosable from the response.
      autoConfirmReason,
      // The stable half of the answer: a client branches on this and never on
      // the sentence beside it. The proposal's own status is not on the wire,
      // so before this there was nothing to branch on that could tell "waiting
      // for the consultant" from "nothing is pending any more".
      outcome: outcome.code,
      message: outcome.message,
    });
  } catch (error) {
    // A typed refusal (the reschedule window) answers with its own status.
    //
    // This is the only path of the four reschedule refusals that does not
    // return its own `NextResponse`: `apiError` serialises a `Refusal` as
    // `{ error, errorType, code }`, so `RESCHEDULE_WINDOW` still reaches the
    // client as a branchable code. The other three are the explicit branches
    // below (`RESCHEDULE_ALREADY_OPEN`) or the `httpStatus`/`code` pair thrown
    // inside the transaction (`PROPOSAL_COUNT_MISMATCH`,
    // `PROPOSAL_WINDOW_CLOSED`).
    if (isRefusal(error)) {
      return apiError({ tag: "[Reschedule.POST]", error });
    }
    // #1319 — lock outcomes are structured, never a 500.
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof AppointmentBusyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    // openForAppointmentId is a nullable @unique, so a second reschedule while
    // one is still open is MEANT to fail here — that is the DB-level guarantee
    // of at most one live proposal per appointment. Without this branch the
    // expected outcome surfaced as a 500 "Failed to request reschedule" and
    // was reported to Sentry as an unexpected error.
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        {
          error: "A reschedule request is already open for this booking.",
          code: "RESCHEDULE_ALREADY_OPEN",
        },
        { status: 409 },
      );
    }

    // B2 — the CAS guard's structured 409 (NOT_RESCHEDULABLE).
    if (error instanceof Error && "httpStatus" in error) {
      const status =
        typeof (error as { httpStatus?: number }).httpStatus === "number"
          ? (error as { httpStatus: number }).httpStatus
          : 500;
      const code =
        "code" in error && typeof (error as { code?: string }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      return NextResponse.json(
        { error: error.message, ...(code && { code }) },
        { status },
      );
    }
    // Type-safe error handling using custom error classes
    if (error instanceof RescheduleAuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    if (error instanceof AppointmentTypeMismatchError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof AppointmentNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    // Only log unexpected errors — the known error types above are normal control flow
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    console.error("Error requesting reschedule:", error);
    return NextResponse.json(
      { error: "Failed to request reschedule" },
      { status: 500 },
    );
  }
}
