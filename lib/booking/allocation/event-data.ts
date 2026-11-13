// The allocator's event read (consultant, config, org context) and the CAS
// status write that lands the event once its times exist.

import type { Tx, PrismaLike } from "@/lib/prisma";
import {
  AppointmentStatus,
  OccurrenceCompletionStatus,
  PaymentStatus,
} from "@prisma/client";
import { addMonths } from "date-fns";
import {
  EventType,
  ConsultantAllocationData,
  EventConfig,
} from "@/utils/scheduling-engine/types";
import {
  bookedSessionMinutes,
  intervalStartsOf,
} from "@/lib/appointments/occurrences";
import { isVoidRequestRow } from "@/lib/booking/allocation/counts";
import { isLiveCheckoutHold } from "@/lib/booking/request-cohort";
import { assertUnpaidApprovalFits } from "@/lib/booking/lead-time";
import { WEEKLY_COVERAGE_SELECT } from "@/utils/scheduling-engine/availabilityCoverage";
import {
  lastInstantBefore,
  soldSessionMinutes,
  soldSessionsPerWeek,
  soldTermsOf,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { formatDateLabel } from "@/lib/time/display";
import { agreedConsultationPricePaise } from "@/lib/booking/sold-terms";
import {
  ALLOCATION_APPROVABLE_FROM,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { subscriptionUnpaidError } from "@/lib/booking/booking-rule-error";
import {
  SETTLED_CONSULTATION,
  SETTLED_SUBSCRIPTION,
  UNPAID_CONSULTATION,
  UNPAID_SUBSCRIPTION,
  type ApprovalOutcome,
} from "@/lib/booking/approve-request";
import {
  AllocationValidationError,
  AllocationNotFoundError,
} from "@/utils/scheduling-engine/errors";

/**
 * #1775 B-9 — an unpaid approval's freshly placed sessions are the hold
 * its pay order is for, not confirmed times: created confirmed by
 * `createAppointments`, they are marked tentative here so the capture
 * webhook confirms them and a lapse or withdraw releases them by status.
 */
export async function holdUntilPaid(
  tx: Tx,
  appointments: { id: string }[],
  outcome: ApprovalOutcome | undefined,
): Promise<void> {
  if (outcome !== "awaiting_payment" || appointments.length === 0) return;
  await tx.appointmentOccurrence.updateMany({
    where: {
      appointmentId: { in: appointments.map((a) => a.id) },
      deletedAt: null,
      completionStatus: OccurrenceCompletionStatus.SCHEDULED,
    },
    data: { isTentative: true },
  });
}

/**
 * #1775 B-9 — two CAS attempts, the money predicate in each WHERE. The
 * first lands a settled request in APPROVED (the self-edge keeps
 * re-allocation of a paid booking legal); the second lands an unpaid one in
 * APPROVED_PENDING_PAYMENT from PENDING or from itself. Both missing means
 * the row is not approvable (cancelled, expired, or a wrapper in an odd
 * money state) and the allocation rolls back as before.
 */
export async function approveByMoney<
  W extends { id: string },
  D extends object,
>(
  eventId: string,
  transition: (args: {
    where: W;
    to: AppointmentStatus;
    fromIn: AppointmentStatus[];
    data?: D;
    reason?: string;
  }) => Promise<void>,
  settled: Omit<W, "id">,
  unpaid: Omit<W, "id"> | (() => Promise<void>),
  data?: D,
  approvableFrom: AppointmentStatus[] = ALLOCATION_APPROVABLE_FROM,
  /** Runs before the awaiting-payment write; a throw refuses the approval. */
  beforeUnpaid?: () => void,
  /** Recorded on the history row: how the times were placed. */
  reason?: string,
): Promise<ApprovalOutcome> {
  try {
    await transition({
      where: { id: eventId, ...settled } as W,
      to: AppointmentStatus.APPROVED,
      fromIn: approvableFrom,
      data,
      reason,
    });
    return "approved";
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    // #1775 C-1 — a refusal instead of the awaiting-payment edge; it throws
    // a typed error for an unpaid row, else the original miss stands.
    if (typeof unpaid === "function") {
      await unpaid();
      throw error;
    }
  }
  beforeUnpaid?.();
  await transition({
    where: { id: eventId, ...unpaid } as W,
    to: AppointmentStatus.APPROVED_PENDING_PAYMENT,
    fromIn: [
      AppointmentStatus.PENDING,
      AppointmentStatus.APPROVED_PENDING_PAYMENT,
    ].filter((status) => approvableFrom.includes(status)),
    data,
    reason,
  });
  return "awaiting_payment";
}

/**
 * Update event status after allocation
 */
export async function updateEventStatus(
  tx: Tx,
  eventType: EventType,
  eventId: string,
  firstSlot: Date,
  config: EventConfig,
  approvableFrom?: AppointmentStatus[],
  /** How the times were placed (`scheduleReason`), for the history row. */
  reason?: string,
): Promise<ApprovalOutcome | undefined> {
  switch (eventType) {
    // #836 — allocation racing a cancel/expiry must not resurrect the
    // request to APPROVED; the allowed-from guard rides the WHERE and a
    // miss rolls back the whole allocation tx. fromIn keeps the APPROVED
    // self-edge legal for re-allocation of an already-approved event.
    // #1775 B-9 — allocation IS the approval, and the money decides where
    // it lands: a settled wrapper (SUCCEEDED payment, or a free plan) goes
    // to APPROVED; an unpaid request goes to APPROVED_PENDING_PAYMENT and
    // the caller mints the pay order after the commit. Both predicates
    // ride the CAS WHERE; an unpaid row that already awaits payment keeps
    // its live link (self-edge), it is never re-stamped APPROVED.
    case "consultation":
      return approveByMoney(
        eventId,
        (args) => transitionConsultationRequest(tx, args),
        SETTLED_CONSULTATION,
        UNPAID_CONSULTATION,
        undefined,
        approvableFrom,
        // The client pays before the session: refuse a too-close first one.
        () => assertUnpaidApprovalFits(firstSlot),
        reason,
      );

    // #1775 C-1 — a plan is paid at purchase: an unpaid one is refused,
    // never parked in APPROVED_PENDING_PAYMENT.
    case "subscription":
      return approveByMoney(
        eventId,
        (args) => transitionSubscriptionRequest(tx, args),
        SETTLED_SUBSCRIPTION,
        async () => {
          const unpaid = await tx.subscription.count({
            where: {
              id: eventId,
              status: { in: approvableFrom ?? ALLOCATION_APPROVABLE_FROM },
              ...UNPAID_SUBSCRIPTION,
            },
          });
          if (unpaid > 0) {
            throw subscriptionUnpaidError();
          }
        },
        undefined,
        approvableFrom,
        undefined,
        reason,
      );

    case "webinar": {
      // Allocation gives an event its sessions; it never publishes one, so a
      // DRAFT keeps DRAFT while CANCELLED/COMPLETED are still refused.
      try {
        await transitionWebinarEvent(tx, {
          where: { id: eventId },
          to: "SCHEDULED",
        });
      } catch (error) {
        if (
          !(error instanceof IllegalTransitionError) ||
          error.from !== "DRAFT"
        ) {
          throw error;
        }
      }
      break;
    }

    case "class": {
      // Class model HAS schedulingPeriod fields
      // FIX: Only set schedulingPeriod if not already configured — same guard as SUBSCRIPTION.
      // Overwriting an explicitly-set period on re-allocation shifts the window, allowing
      // slots outside the original range to pass the scheduling-period validation check.
      const periodData =
        !config.schedulingPeriodStartsAt || !config.schedulingPeriodEndsAt
          ? {
              schedulingPeriodStartsAt: firstSlot,
              schedulingPeriodEndsAt: addMonths(
                firstSlot,
                config.durationInMonths || 2,
              ),
            }
          : {};

      // Same DRAFT-keeps-its-status rule as WEBINAR above.
      try {
        await transitionClassEvent(tx, {
          where: { id: eventId },
          to: "SCHEDULED",
          data: periodData,
        });
      } catch (error) {
        if (
          !(error instanceof IllegalTransitionError) ||
          error.from !== "DRAFT"
        ) {
          throw error;
        }
        // A draft still needs its scheduling period, or its new slots sit
        // outside a window that is never set.
        if (Object.keys(periodData).length > 0) {
          await tx.class.updateMany({
            where: { id: eventId, status: "DRAFT" },
            data: periodData,
          });
        }
      }
      break;
    }
  }
}

/**
 * Fetch event data including consultant and config
 */
export async function fetchEventData(
  // #908 — accepts the base client so event/config reads can run OUTSIDE the
  // write transaction (under the locks). Reads only.
  db: PrismaLike,
  eventType: EventType,
  eventId: string,
): Promise<{
  consultant: ConsultantAllocationData;
  config: EventConfig;
  consulteeUserId?: string;
  requestedSlots?: Date[];
  /**
   * Org context for any Appointment rows created by this allocation.
   * Resolved per event type; see #768 Comment 5.
   */
  organizationId?: string | null;
  /** AE-2 (#784) — the plan the co-host guard reads its collaborators from. */
  planId?: string | null;
  /**
   * Whether the booking is paid (or free): it decides the lead time a placed
   * session needs (`leadMsFor`). Only an unpaid consultation request is not.
   */
  settled: boolean;
  /** The buyer's own direct checkout is still being paid: nobody may answer it yet. */
  checkoutInProgress: boolean;
} | null> {
  // Only rows that can still host a slot: every path refuses a past slot, so a
  // custom row that has ended can never contain one.
  const consultantProfileSelect = {
    select: {
      user: { select: { id: true, timezone: true } },
      scheduleType: true,
      availabilityWindowsWeekly: { select: WEEKLY_COVERAGE_SELECT },
      availabilityWindowsCustom: {
        where: { endsAt: { gt: new Date() } },
        select: { id: true, startsAt: true, endsAt: true },
      },
      _count: { select: { availabilityWindowsCustom: true } },
    },
  } as const;
  const requestedBySelect = {
    select: { user: { select: { id: true } } },
  } as const;

  let consultantProfile:
    | {
        user: { id: string; timezone?: string | null };
        scheduleType: "WEEKLY" | "CUSTOM";
        availabilityWindowsWeekly: ConsultantAllocationData["availabilityWindowsWeekly"];
        availabilityWindowsCustom: ConsultantAllocationData["availabilityWindowsCustom"];
        _count?: { availabilityWindowsCustom: number };
      }
    | null
    | undefined;
  let config: EventConfig;
  let consulteeUserId: string | undefined;
  let requestedSlots: Date[] | undefined;
  // #768 Comment 5
  let organizationId: string | null = null;
  // AE-2 (#784) — webinar/class only; the other two have no collaborators.
  let planId: string | null = null;
  let settled = true;
  let checkoutInProgress = false;

  switch (eventType) {
    case "consultation": {
      const event = await db.consultation.findUnique({
        where: { id: eventId },
        select: {
          agreedPricePaise: true,
          consultationPlan: {
            select: {
              durationInHours: true,
              price: true,
              consultantProfile: consultantProfileSelect,
            },
          },
          requestedBy: requestedBySelect,
          appointment: {
            select: {
              organizationId: true,
              occurrences: {
                select: {
                  startsAt: true,
                  endsAt: true,
                  deletedAt: true,
                  completionStatus: true,
                },
              },
              payment: {
                where: {
                  deletedAt: null,
                  paymentStatus: {
                    in: [PaymentStatus.SUCCEEDED, PaymentStatus.PENDING],
                  },
                },
                select: { paymentStatus: true, expiresAt: true },
              },
            },
          },
          bookingSource: true,
        },
      });
      if (!event) return null;
      consultantProfile = event.consultationPlan?.consultantProfile;
      const payments = event.appointment?.payment ?? [];
      // The same money predicate the approval CAS rides (SETTLED_CONSULTATION).
      settled =
        payments.some((p) => p.paymentStatus === PaymentStatus.SUCCEEDED) ||
        agreedConsultationPricePaise(event) === 0;
      checkoutInProgress = isLiveCheckoutHold(
        event.bookingSource,
        payments,
        new Date(),
      );
      // The booked session's length; the plan's only for a booking with no session row.
      const bookedMinutes = bookedSessionMinutes(
        event.appointment?.occurrences ?? [],
      );
      config = {
        durationInHours:
          bookedMinutes === null
            ? event.consultationPlan?.durationInHours
            : bookedMinutes / 60,
      };
      consulteeUserId = event.requestedBy?.user?.id;
      // #1319 — atom STARTS, not one entry per row. The approval gate counts
      // covered half-hour atoms and `validateConsultation` compares against
      // `getSlotsPerCall`, so a legacy 60-minute row offered as one requested
      // slot answered "1" to both questions and could never be approved.
      requestedSlots = event.appointment?.occurrences
        ?.filter((s) => !isVoidRequestRow(s))
        .flatMap((s) => intervalStartsOf(s));
      // #768 — preserve org tag across reschedule (delete+recreate).
      organizationId = event.appointment?.organizationId ?? null;
      break;
    }

    case "subscription": {
      const event = await db.subscription.findUnique({
        where: { id: eventId },
        select: {
          sessionsTotal: true,
          sessionsPerWeek: true,
          sessionMinutes: true,
          sessionsRefunded: true,
          schedulingPeriodStartsAt: true,
          schedulingTimezone: true,
          planEndsAt: true,
          subscriptionPlan: {
            select: {
              totalSessions: true,
              sessionsPerWeek: true,
              durationInMonths: true,
              sessionDurationInHours: true,
              consultantProfile: consultantProfileSelect,
            },
          },
          requestedBy: requestedBySelect,
          appointment: {
            select: {
              organizationId: true,
              occurrences: {
                select: {
                  startsAt: true,
                  endsAt: true,
                  completionStatus: true,
                  isTentative: true,
                  deletedAt: true,
                },
              },
              payment: {
                select: {
                  organizationId: true,
                  paymentStatus: true,
                  expiresAt: true,
                  deletedAt: true,
                },
              },
            },
          },
          bookingSource: true,
        },
      });
      if (!event) return null;
      consultantProfile = event.subscriptionPlan?.consultantProfile;
      checkoutInProgress = isLiveCheckoutHold(
        event.bookingSource,
        (event.appointment?.payment ?? []).filter((p) => !p.deletedAt),
        new Date(),
      );
      // #1766 — one counter: the frozen entitlement and the current cycle
      // decide how many sessions this run may place and in which window.
      const entitlement = subscriptionEntitlement({
        ...soldTermsOf(event),
        occurrences: event.appointment?.occurrences ?? [],
        schedulingPeriodStartsAt: event.schedulingPeriodStartsAt,
        schedulingTimezone: event.schedulingTimezone,
        planEndsAt: event.planEndsAt,
      });
      if (entitlement.cycle.windowEnd <= entitlement.cycle.windowStart) {
        throw new AllocationValidationError(
          `This plan ended on ${formatDateLabel(
            lastInstantBefore(entitlement.planEndsAt),
            { zone: event.schedulingTimezone },
          )}, so no more sessions can be booked. Any unused paid sessions are refunded automatically.`,
          "PERIOD_ENDED",
        );
      }
      config = {
        durationInMonths: event.subscriptionPlan.durationInMonths,
        // The terms frozen at purchase, not today's plan row.
        sessionsPerWeek: soldSessionsPerWeek(event),
        sessionDurationInHours: soldSessionMinutes(event) / 60,
        totalSessions: entitlement.total,
        cycleTargetSessions: entitlement.cycle.nextBatch,
        schedulingPeriodStartsAt: entitlement.cycle.windowStart,
        schedulingPeriodEndsAt: entitlement.cycle.windowEnd,
        schedulingTimezone: event.schedulingTimezone ?? undefined,
      };
      consulteeUserId = event.requestedBy?.user?.id;
      // #1319 — same coverage rule as the consultation arm above.
      requestedSlots = event.appointment?.occurrences
        .filter((s) => !isVoidRequestRow(s))
        .flatMap((s) => intervalStartsOf(s));
      // #768 — the purchase wrapper from checkout carries the org tag.
      // New lazy-allocated occurrences inherit it.
      organizationId =
        event.appointment?.organizationId ??
        event.appointment?.payment.find((p) => p?.organizationId)
          ?.organizationId ??
        null;
      break;
    }

    case "webinar": {
      const event = await db.webinar.findUnique({
        where: { id: eventId },
        select: {
          webinarPlanId: true,
          webinarPlan: {
            select: {
              durationInHours: true,
              organizationId: true,
              consultantProfile: consultantProfileSelect,
            },
          },
        },
      });
      if (!event) return null;
      consultantProfile = event.webinarPlan?.consultantProfile;
      config = {
        durationInHours: event.webinarPlan?.durationInHours,
      };
      // #768 — WEBINAR Appointment is SHARED across registrants from
      // multiple orgs; tag with the plan's host org if any.
      organizationId = event.webinarPlan?.organizationId ?? null;
      planId = event.webinarPlanId ?? null;
      break;
    }

    case "class": {
      const event = await db.class.findUnique({
        where: { id: eventId },
        select: {
          classPlanId: true,
          schedulingPeriodStartsAt: true,
          schedulingPeriodEndsAt: true,
          schedulingTimezone: true,
          classPlan: {
            select: {
              sessionDurationInHours: true,
              durationInMonths: true,
              sessionsPerWeek: true,
              totalSessions: true,
              organizationId: true,
              consultantProfile: consultantProfileSelect,
            },
          },
        },
      });
      if (!event) return null;
      consultantProfile = event.classPlan?.consultantProfile;
      // The plan's sessionDurationInHours is the ONE source of truth for a
      // class session's slot count: crud-with-plan writes tentative slots at
      // this duration, /validate validates against it, and the client picks
      // slots with it. The former avg(classContents.hoursAllotted)
      // derivation disagreed with all three whenever a curriculum item's
      // hours differed from the plan — validate passed while allocate
      // rejected, and createAppointments regrouped sessions to the wrong
      // length. Curriculum items describe content coverage, not the length
      // of the sessions that teach it.
      const sessionDuration = event.classPlan?.sessionDurationInHours || 1;

      config = {
        durationInMonths: event.classPlan?.durationInMonths,
        sessionsPerWeek: event.classPlan?.sessionsPerWeek,
        sessionDurationInHours: sessionDuration,
        totalSessions: event.classPlan?.totalSessions,
        schedulingPeriodStartsAt: event.schedulingPeriodStartsAt ?? undefined,
        schedulingPeriodEndsAt: event.schedulingPeriodEndsAt ?? undefined,
        schedulingTimezone: event.schedulingTimezone ?? undefined,
      };
      // #768 — CLASS sessions inherit host-org from the plan; locked
      // even on reschedule. Marketplace classes stay null.
      organizationId = event.classPlan?.organizationId ?? null;
      planId = event.classPlanId ?? null;
      break;
    }
  }

  if (!consultantProfile) {
    throw new AllocationNotFoundError("Consultant profile not found");
  }

  // FIX: Validate date ordering for events with scheduling periods
  // This prevents bugs in auto-allocation and week calculation
  if (config.schedulingPeriodStartsAt && config.schedulingPeriodEndsAt) {
    if (config.schedulingPeriodStartsAt >= config.schedulingPeriodEndsAt) {
      throw new AllocationValidationError(
        `This ${eventType}'s scheduling period ends before it starts. Fix the dates on the plan, then try again.`,
        "VALIDATION_ERROR",
        {
          schedulingPeriodStartsAt:
            config.schedulingPeriodStartsAt.toISOString(),
          schedulingPeriodEndsAt: config.schedulingPeriodEndsAt.toISOString(),
        },
      );
    }
  }

  return {
    consultant: {
      userId: consultantProfile.user.id,
      scheduleType: consultantProfile.scheduleType,
      availabilityWindowsWeekly: consultantProfile.availabilityWindowsWeekly,
      availabilityWindowsCustom: consultantProfile.availabilityWindowsCustom,
      hasCustomRows: consultantProfile._count
        ? consultantProfile._count.availabilityWindowsCustom > 0
        : undefined,
      timezone: consultantProfile.user.timezone ?? undefined,
    },
    config,
    consulteeUserId,
    requestedSlots,
    organizationId,
    planId,
    settled,
    checkoutInProgress,
  };
}
