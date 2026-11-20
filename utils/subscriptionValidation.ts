import type { PrismaLike } from "@/lib/prisma";
import {
  lastInstantBefore,
  soldSessionMinutes,
  soldTermsOf,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";

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
 * atom inside the current cycle's half-open window, no more whole sessions
 * than the cycle's `nextBatch`, and never past the frozen entitlement. The
 * rolling cycle is the only weekly counter.
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
    });
    const { windowStart, windowEnd, nextBatch } = entitlement.cycle;

    const cycleCalls = countWholeCalls(
      proposedSlotDates,
      soldSessionMinutes(subscription) / 60,
    );

    const result: SubscriptionValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      cycleCalls,
      cycleCap: nextBatch,
      // The entitlement's own count, so a session it asks to replace fits.
      totalCallsScheduled: entitlement.held + cycleCalls,
      maxTotalCalls: entitlement.total,
      subscriptionPeriod: { start: windowStart, end: windowEnd },
    };

    for (const slot of proposedSlotDates) {
      const slotEnd = new Date(slot.getTime() + SCHEDULING_INTERVAL_MS);
      if (slot < windowStart || slotEnd > windowEnd) {
        result.isValid = false;
        result.errors.push(
          `[OUTSIDE_PLAN_WEEK] Slot ${slot.toISOString()} is outside the open plan week (${windowStart.toISOString()} - ${lastInstantBefore(windowEnd).toISOString()})`,
        );
      }
    }

    if (cycleCalls > nextBatch) {
      result.isValid = false;
      result.errors.push(
        `[PLAN_WEEK_FULL] This plan week has room for ${nextBatch} more session${nextBatch === 1 ? "" : "s"}, but ${cycleCalls} were picked.`,
      );
    }

    if (result.totalCallsScheduled > result.maxTotalCalls) {
      result.isValid = false;
      result.errors.push(
        `[PLAN_TOTAL_REACHED] Total calls (${result.totalCallsScheduled}) exceed subscription limit (${result.maxTotalCalls})`,
      );
    }

    return result;
  }
}

/**
 * Whole sessions in a set of atoms: consecutive atoms (1 s tolerance) group
 * into runs and each run yields floor(run / atomsPerCall) calls, so an
 * overnight call crossing midnight still counts once.
 */
function countWholeCalls(
  slotDates: Date[],
  sessionDurationInHours: number,
): number {
  const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);
  if (slotDates.length < slotsPerCall) return 0;
  const TOLERANCE_MS = 1000;
  const sorted = [...slotDates].sort((a, b) => a.getTime() - b.getTime());
  let calls = 0;
  let runLength = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].getTime() + SCHEDULING_INTERVAL_MS;
    if (Math.abs(sorted[i].getTime() - prevEnd) <= TOLERANCE_MS) {
      runLength += 1;
    } else {
      calls += Math.floor(runLength / slotsPerCall);
      runLength = 1;
    }
  }
  return calls + Math.floor(runLength / slotsPerCall);
}
