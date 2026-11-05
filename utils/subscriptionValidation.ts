import type { PrismaLike } from "@/lib/prisma";
import {
  lastInstantBefore,
  soldSessionMinutes,
  soldTermsOf,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { OCCUPIED_REQUEST_STATUSES } from "@/utils/scheduling-engine/occupancyPolicy";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";
import {
  LIVE_REGULAR_TIME_PROBE,
  hasLiveRegularTime,
} from "@/lib/booking/regular-time/queries";

interface SubscriptionValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  /** Whole sessions the proposal places in the current cycle. */
  cycleCalls: number;
  /** Sessions the current cycle still has room for. */
  cycleCap: number;
  totalCallsScheduled: number;
  maxTotalCalls: number;
  /** The current cycle's half-open window, clamped to the plan end. */
  subscriptionPeriod: {
    start: Date;
    end: Date;
  };
}

/**
 * Server-side subscription rules for a proposed set of 30-minute atoms: every
 * atom inside one open plan week of the entitlement's horizon (not before
 * now), no more whole sessions in a week than it has room for, and never past
 * the frozen entitlement.
 */
export class SubscriptionValidationService {
  constructor(private readonly prisma: PrismaLike) {}

  async validateSubscriptionSlots(
    subscriptionId: string,
    proposedSlots: string[],
    excludeAppointmentIds: string[] = [],
    excludeOccurrenceIds: string[] = [],
  ): Promise<SubscriptionValidationResult> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: true,
        regularTimes: LIVE_REGULAR_TIME_PROBE,
        appointment: {
          select: {
            id: true,
            occurrences: {
              select: {
                id: true,
                startsAt: true,
                endsAt: true,
                completionStatus: true,
                isTentative: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    const schedulingTimezone =
      subscription.schedulingTimezone ??
      ScheduleCalculationService.DEFAULT_SCHEDULING_TIMEZONE;
    const proposedSlotDates = proposedSlots.map((slot) => new Date(slot));

    // The rows being replaced do not hold their cycle places. A released
    // reschedule row holds none anyway and stays: it is what tells the
    // entitlement a reschedule is open, so the cycle anchors as the allocator's.
    const excludedOccurrences = new Set(excludeOccurrenceIds);
    const wrapper = subscription.appointment;
    const keptOccurrences =
      wrapper && !excludeAppointmentIds.includes(wrapper.id)
        ? wrapper.occurrences.filter(
            (o) => !excludedOccurrences.has(o.id) || isReleasedForReschedule(o),
          )
        : [];
    const entitlement = subscriptionEntitlement({
      ...soldTermsOf(subscription),
      occurrences: keptOccurrences,
      schedulingPeriodStartsAt: subscription.schedulingPeriodStartsAt,
      schedulingTimezone,
      planEndsAt: subscription.planEndsAt,
      hasRegularTime: hasLiveRegularTime(subscription),
    });
    const { windowStart, windowEnd, nextBatch } = entitlement.cycle;
    const { horizon } = entitlement;

    const existingCalls = await this.countExistingCalls(
      subscriptionId,
      excludeAppointmentIds,
      excludeOccurrenceIds,
    );
    const callStarts = wholeCallStarts(
      proposedSlotDates,
      soldSessionMinutes(subscription) / 60,
    );
    const cycleCalls = callStarts.length;

    const result: SubscriptionValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      cycleCalls,
      cycleCap: nextBatch,
      totalCallsScheduled: existingCalls + cycleCalls,
      maxTotalCalls: entitlement.total,
      subscriptionPeriod: { start: windowStart, end: windowEnd },
    };

    const nowMs = Date.now();
    const weekOf = (atom: Date) => {
      const atomEnd = atom.getTime() + SCHEDULING_INTERVAL_MS;
      return horizon.find(
        (w) =>
          atom.getTime() >= Math.max(w.startsAt.getTime(), nowMs) &&
          atomEnd <= w.endsAt.getTime(),
      );
    };
    for (const slot of proposedSlotDates) {
      if (!weekOf(slot)) {
        result.isValid = false;
        result.errors.push(
          `Slot ${slot.toLocaleDateString()} is outside this cycle (${windowStart.toLocaleDateString()} - ${lastInstantBefore(horizon.at(-1)?.endsAt ?? windowEnd).toLocaleDateString()})`,
        );
      }
    }

    for (const week of horizon) {
      const room = Math.max(
        0,
        Math.min(week.capacity - week.held, entitlement.remaining),
      );
      const picked = callStarts.filter((s) => weekOf(s) === week).length;
      if (picked > room) {
        result.isValid = false;
        const which =
          horizon.length === 1 ? "This cycle" : `Week ${week.weekIndex + 1}`;
        result.errors.push(
          `${which} has room for ${room} more session${room === 1 ? "" : "s"}, but ${picked} were picked.`,
        );
      }
    }

    if (result.totalCallsScheduled > result.maxTotalCalls) {
      result.isValid = false;
      result.errors.push(
        `Total calls (${result.totalCallsScheduled}) exceed subscription limit (${result.maxTotalCalls})`,
      );
    }

    return result;
  }

  /** Live occurrence rows on the wrapper, minus the rows being replaced. */
  private async countExistingCalls(
    subscriptionId: string,
    excludeAppointmentIds: string[],
    excludeOccurrenceIds: string[],
  ): Promise<number> {
    const rows = await this.prisma.appointmentOccurrence.findMany({
      where: {
        id: { notIn: excludeOccurrenceIds },
        deletedAt: null,
        completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
        appointment: {
          subscriptionId,
          id: { notIn: excludeAppointmentIds },
          subscription: { status: { in: OCCUPIED_REQUEST_STATUSES } },
        },
      },
      select: { id: true },
    });
    return rows.length;
  }
}

/**
 * The start of each whole session in a set of atoms: consecutive atoms (1 s
 * tolerance) group into runs and each run yields floor(run / atomsPerCall)
 * calls, so an overnight call crossing midnight still counts once.
 */
function wholeCallStarts(
  slotDates: Date[],
  sessionDurationInHours: number,
): Date[] {
  const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);
  if (slotDates.length < slotsPerCall) return [];
  const TOLERANCE_MS = 1000;
  const sorted = [...slotDates].sort((a, b) => a.getTime() - b.getTime());
  const starts: Date[] = [];
  let run: Date[] = [sorted[0]];
  const flush = () => {
    for (let i = 0; i + slotsPerCall <= run.length; i += slotsPerCall)
      starts.push(run[i]);
  };
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].getTime() + SCHEDULING_INTERVAL_MS;
    if (Math.abs(sorted[i].getTime() - prevEnd) <= TOLERANCE_MS) {
      run.push(sorted[i]);
    } else {
      flush();
      run = [sorted[i]];
    }
  }
  flush();
  return starts;
}
