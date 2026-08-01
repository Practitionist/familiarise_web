import * as Sentry from "@sentry/nextjs";
import {
  TimeSlot,
  calculateRequiredSlots,
  countSundayWeeksInclusive,
  validateSlotDistribution,
} from "./calendarUtils";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { countSessionsForDay } from "./slotSelectionValidation";
import { isRecurringEventType } from "@/utils/slotAllocation/types";
import { AllocationService } from "./allocationService";

/**
 * AUTO ALLOCATION ENHANCEMENT SYSTEM
 * ==================================
 *
 * MAJOR ENHANCEMENTS IMPLEMENTED:
 *
 * 1. MULTIPLE ALLOCATION STRATEGIES:
 *    - Consultation: "earliest-available" strategy
 *    - Webinar: "consecutive-slots" strategy for multi-hour events
 *    - Subscription/Class: "optimal-distribution" strategy with weekly spreading
 *
 * 2. SMART SCORING ALGORITHM:
 *    - Time scoring: Prime business hours (10-4) score 10, extended hours lower
 *    - Day scoring: Tuesday/Wednesday/Thursday highest, weekends lowest
 *    - Intelligent spacing to avoid conflicts
 *
 * Consultee-stated preferences are NOT handled here. They live on the server
 * allocator (utils/slotAllocation/preferenceScoring.ts) and score candidates
 * rather than filtering them — see #1065 and autoAllocate below.
 */

export interface AllocationOptions {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  durationInMonths?: number;
  sessionsPerWeek?: number;
  sessionDurationInHours?: number;
  durationInHours?: number; // FIXED: Add durationInHours for consultations and webinars
  startDate?: Date; // Required for subscriptions and classes
  endDate?: Date; // Required for subscriptions and classes
  totalSessions?: number; // Authoritative session count from plan (overrides weeks × sessionsPerWeek)
  requestedSlots?: TimeSlot[];
  pastConfirmedSlotCount?: number; // For in-progress recurring events
  // Per-day session cap, mirroring the manual interactive guard so auto-allocate
  // can't cluster more sessions on one day than a consultant could place by hand
  // (subscription default 1, class default 2).
  maxCallsPerDay?: number; // subscriptions
  maxSessionsPerDay?: number; // classes
  // Idempotency-Key for the allocate request; a double-submit replays the
  // original batch server-side instead of double-booking (#837).
  idempotencyKey?: string;
  // Reject with 409 if the event already has confirmed slots (multi-tab guard).
  initialAllocation?: boolean;
  // Timezone defining the limit day/week buckets (ADR B9); defaults to
  // Asia/Kolkata in the shared helpers.
  schedulingTimezone?: string;
}

export interface AllocationResult {
  success: boolean;
  selectedSlots: TimeSlot[];
  error?: string;
  strategy?: string;
  /** HTTP status of a failed allocate call — 409 means "allocated elsewhere". */
  httpStatus?: number;
}

/**
 * Hours between two sessions placed on the same day by the recurring
 * allocator. Was a caller-supplied preference; nothing ever supplied one.
 */
const MIN_HOURS_BETWEEN_SAME_DAY_SESSIONS = 2;

/**
 * Enhanced allocation algorithms with smart preference-based selection
 */
export class AllocationAlgorithms {
  /**
   * Manual allocation - uses the slots selected by the user
   * ENHANCED: Better validation and error handling
   */
  static async manualAllocate(
    selectedSlots: TimeSlot[],
    options: AllocationOptions,
  ): Promise<AllocationResult> {
    try {
      // VALIDATION: Check required slots count
      // Pass durationInHours for consultations/webinars, sessionDurationInHours for subscriptions/classes
      const rawRequired = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.sessionsPerWeek,
        options.durationInHours || options.sessionDurationInHours,
        options.startDate,
        options.endDate,
        options.totalSessions,
      );

      // For in-progress recurring events, subtract past confirmed slots
      const pastCount = options.pastConfirmedSlotCount || 0;
      const requiredSlots =
        isRecurringEventType(options.eventType) && pastCount > 0
          ? Math.max(0, rawRequired - pastCount)
          : rawRequired;

      if (selectedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Expected ${requiredSlots} slots but received ${selectedSlots.length}`,
        };
      }

      // VALIDATION: No past slots allowed
      const now = new Date();
      const pastSlots = selectedSlots.filter((slot) => slot.startTime < now);
      if (pastSlots.length > 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "Cannot allocate slots in the past",
        };
      }

      // BUSINESS RULE: Webinar slots must be consecutive
      if (options.eventType === "webinar" && selectedSlots.length > 1) {
        const sortedSlots = [...selectedSlots].sort(
          (a, b) => a.startTime.getTime() - b.startTime.getTime(),
        );

        for (let i = 1; i < sortedSlots.length; i++) {
          const prevSlot = sortedSlots[i - 1];
          const currentSlot = sortedSlots[i];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            return {
              success: false,
              selectedSlots: [],
              error: "Webinar slots must be consecutive",
            };
          }
        }
      }

      // BUSINESS RULE: Subscription/Class distribution validation
      if (
        options.eventType === "subscription" ||
        options.eventType === "class"
      ) {
        if (!options.sessionsPerWeek) {
          return {
            success: false,
            selectedSlots: [],
            error:
              "Calls per week is required for subscription/class allocation",
          };
        }

        // Calculate slotsPerWeek based on actual session duration
        // slotsPerSession = sessionDurationInHours / 0.5 (since each slot is 30 min)
        // slotsPerWeek = sessionsPerWeek * slotsPerSession
        const slotsPerSession = Math.ceil(
          (options.sessionDurationInHours || 1) / 0.5,
        );
        const slotsPerWeek = options.sessionsPerWeek * slotsPerSession;

        const distributionValidation = validateSlotDistribution(
          selectedSlots,
          slotsPerWeek,
          options.schedulingTimezone,
        );

        if (!distributionValidation.isValid) {
          return {
            success: false,
            selectedSlots: [],
            error: distributionValidation.errorMessage,
          };
        }

        // Every scheduling-timezone day must decompose into complete
        // CONSECUTIVE sessions — a length-modulo check would let scattered
        // fragments reach the required total while forming no real session,
        // which the server then rejects.
        const byDay = SlotCalculationService.groupSlotsByDay(
          selectedSlots,
          options.schedulingTimezone ??
            SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE,
        );
        for (const [, daySlots] of Array.from(byDay)) {
          const { sessions } = countSessionsForDay(daySlots, slotsPerSession);
          if (sessions * slotsPerSession !== daySlots.length) {
            return {
              success: false,
              selectedSlots: [],
              error: `Each session needs ${slotsPerSession} consecutive slots on one day; an incomplete session is selected.`,
            };
          }
        }
      }

      // Call the allocation service
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        selectedSlots,
        {
          idempotencyKey: options.idempotencyKey,
          initialAllocation: options.initialAllocation,
        },
      );

      if (!allocationResult.success) {
        return {
          success: false,
          selectedSlots: [],
          error: allocationResult.error,
          httpStatus: allocationResult.httpStatus,
        };
      }

      return {
        success: true,
        selectedSlots: selectedSlots,
        strategy: "manual",
      };
    } catch (error) {
      console.warn("Manual allocation error:", error);
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        {
          tags: { subsystem: "client", feature: "slot-allocation" },
          extra: { eventType: options.eventType, mode: "manual" },
        },
      );
      return {
        success: false,
        selectedSlots: [],
        error:
          error instanceof Error ? error.message : "Manual allocation failed",
      };
    }
  }

  /**
   * Client-side auto allocation: pick a schedule, then submit it as a manual
   * batch.
   *
   * #997 Phase 1 — product code calls the SERVER's isAuto mode; this
   * implementation is retained only as the test oracle that pins parity between
   * auto-picked schedules and the manual validators (see mode-parity.test.ts)
   * until phases 2-3 retire the client engine.
   *
   * #1065 — it used to take an `AutoAllocationPreferences` bag and FILTER the
   * candidate slots by it, so prefer-mornings against a consultant with no
   * morning availability returned "not enough slots available" with the whole
   * afternoon free. Preferences now live on the server allocator and SCORE
   * instead (utils/slotAllocation/preferenceScoring.ts); the filtering version
   * is gone rather than left here looking usable.
   */
  static async autoAllocate(
    availableSlots: TimeSlot[],
    options: AllocationOptions,
  ): Promise<AllocationResult> {
    try {
      // Calculate required slots based on event type
      // Pass durationInHours for consultations/webinars, sessionDurationInHours for subscriptions/classes
      const rawRequired = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.sessionsPerWeek,
        options.durationInHours || options.sessionDurationInHours,
        options.startDate,
        options.endDate,
        options.totalSessions,
      );

      // For in-progress recurring events, subtract past confirmed slots
      const pastCount = options.pastConfirmedSlotCount || 0;
      const requiredSlots =
        isRecurringEventType(options.eventType) && pastCount > 0
          ? Math.max(0, rawRequired - pastCount)
          : rawRequired;

      let selectedSlots: TimeSlot[] = [];
      let strategy = "";

      // STEP 1: Drop the slots that are not placeable at all. These are hard
      // constraints, not preferences — a booked or past slot is not a
      // less-liked time, it is not a time.
      const now = new Date();
      const filteredSlots = availableSlots.filter(
        (slot) =>
          slot.startTime > now && slot.isAvailable && !slot.isBooked,
      );

      if (filteredSlots.length < requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Not enough slots available. Need ${requiredSlots}, found ${filteredSlots.length}`,
        };
      }

      // STEP 2: Apply event-specific allocation strategy
      switch (options.eventType) {
        case "consultation":
          // STRATEGY: Earliest available slot with best preference scoring
          selectedSlots = this.allocateConsultationSlots(
            filteredSlots,
            options.durationInHours || 1, // FIXED: Use durationInHours for consultations
          );
          strategy = "earliest-available";
          break;

        case "webinar":
          // STRATEGY: Consecutive slots for multi-hour events
          selectedSlots = this.allocateWebinarSlots(
            filteredSlots,
            options.durationInHours || 1, // FIXED: Use durationInHours for webinars
          );
          strategy = "consecutive-slots";
          break;

        case "subscription":
        case "class":
          // STRATEGY: Optimal distribution across weeks with spacing
          selectedSlots = this.allocateRecurringSlots(
            filteredSlots,
            requiredSlots,
            options.sessionsPerWeek || 1,
            options,
          );
          strategy = "optimal-distribution";
          break;

        default:
          return {
            success: false,
            selectedSlots: [],
            error: `Unsupported event type: ${options.eventType}`,
          };
      }

      if (selectedSlots.length === 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "Could not find suitable slots in the available window",
        };
      }

      if (selectedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Could only allocate ${selectedSlots.length} of ${requiredSlots} required slots`,
        };
      }

      // STEP 3: Call allocation service
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        selectedSlots,
        {
          // NOT isAuto — the slots were computed client-side and are submitted
          // as an explicit manual batch; isAuto would make the server re-pick.
          idempotencyKey: options.idempotencyKey,
          initialAllocation: options.initialAllocation,
        },
      );

      if (!allocationResult.success) {
        return {
          success: false,
          selectedSlots: [],
          error: allocationResult.error,
          httpStatus: allocationResult.httpStatus,
        };
      }

      return {
        success: true,
        selectedSlots,
        strategy,
      };
    } catch (error) {
      console.warn("Auto allocation error:", error);
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        {
          tags: { subsystem: "client", feature: "slot-allocation" },
          extra: { eventType: options.eventType, mode: "auto" },
        },
      );
      return {
        success: false,
        selectedSlots: [],
        error:
          error instanceof Error ? error.message : "Auto allocation failed",
      };
    }
  }

  /**
   * Allocate using the slots the consultee requested (the server's
   * "requested" mode). Formerly named preAllocate.
   */
  static async allocateRequestedSlots(
    options: AllocationOptions,
  ): Promise<AllocationResult> {
    try {
      if (!options.requestedSlots || options.requestedSlots.length === 0) {
        return {
          success: false,
          selectedSlots: [],
          error: "No requested slots provided",
        };
      }

      // Same required-count math as manual/auto, including the in-progress
      // reschedule reduction — the requested path previously skipped it and
      // rejected valid partial reschedules.
      const rawRequired = calculateRequiredSlots(
        options.eventType,
        options.durationInMonths,
        options.sessionsPerWeek,
        options.durationInHours || options.sessionDurationInHours,
        options.startDate,
        options.endDate,
        options.totalSessions,
      );

      const pastCount = options.pastConfirmedSlotCount || 0;
      const requiredSlots =
        isRecurringEventType(options.eventType) && pastCount > 0
          ? Math.max(0, rawRequired - pastCount)
          : rawRequired;

      if (options.requestedSlots.length !== requiredSlots) {
        return {
          success: false,
          selectedSlots: [],
          error: `Requested ${options.requestedSlots.length} slots but need ${requiredSlots}`,
        };
      }

      // Call the allocation service
      const allocationResult = await AllocationService.allocateSlots(
        options.eventType,
        options.eventId,
        options.requestedSlots,
        {
          useRequestedSlots: true,
          idempotencyKey: options.idempotencyKey,
          initialAllocation: options.initialAllocation,
        },
      );

      if (!allocationResult.success) {
        return {
          success: false,
          selectedSlots: [],
          error: allocationResult.error,
          httpStatus: allocationResult.httpStatus,
        };
      }

      return {
        success: true,
        selectedSlots: options.requestedSlots,
        strategy: "requested-slots",
      };
    } catch (error) {
      console.warn("Requested-slots allocation error:", error);
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        {
          tags: { subsystem: "client", feature: "slot-allocation" },
          extra: { eventType: options.eventType, mode: "requested" },
        },
      );
      return {
        success: false,
        selectedSlots: [],
        error:
          error instanceof Error
            ? error.message
            : "Requested-slots allocation failed",
      };
    }
  }

  /**
   * Allocate consecutive slots for consultations.
   * Returns an array of 30-minute TimeSlot objects or empty array if no valid block found.
   */
  private static allocateConsultationSlots(
    availableSlots: TimeSlot[],
    durationHours: number,
  ): TimeSlot[] {
    const requiredSlots = Math.ceil(durationHours / 0.5); // 30-minute intervals

    if (requiredSlots === 1) {
      const sortedSlots = this.sortSlotsByPreference(availableSlots);
      return sortedSlots.slice(0, 1);
    }

    const sortedSlots = availableSlots.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    // FIX: Use Math.ceil(durationHours) to determine how many 1-hour availability
    // blocks are needed, then generate exactly `requiredSlots` 30-min slots from
    // the contiguous range. Previously each block was always split into exactly 2
    // slots, which broke for non-1-hour sessions (e.g. 1.5hr → needed 3, got 4).
    const oneHourBlocksNeeded = Math.ceil(durationHours);
    for (let i = 0; i <= sortedSlots.length - oneHourBlocksNeeded; i++) {
      const consecutive1HourSlots: TimeSlot[] = [];
      let isConsecutive = true;

      for (let j = 0; j < oneHourBlocksNeeded; j++) {
        const currentSlot = sortedSlots[i + j];
        if (!currentSlot) {
          isConsecutive = false;
          break;
        }

        if (j > 0) {
          const prevSlot = consecutive1HourSlots[j - 1];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            isConsecutive = false;
            break;
          }
        }

        consecutive1HourSlots.push(currentSlot);
      }

      if (
        !isConsecutive ||
        consecutive1HourSlots.length < oneHourBlocksNeeded
      ) {
        continue;
      }

      // Generate exactly `requiredSlots` 30-minute slots from the contiguous block
      const blockStart = consecutive1HourSlots[0].startTime;
      const thirtyMinSlots: TimeSlot[] = [];
      for (let k = 0; k < requiredSlots; k++) {
        const slotStart = new Date(blockStart.getTime() + k * 30 * 60000);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60000);
        thirtyMinSlots.push({
          ...consecutive1HourSlots[0],
          startTime: slotStart,
          endTime: slotEnd,
        });
      }

      return thirtyMinSlots;
    }

    return [];
  }

  /**
   * Allocate consecutive slots for webinars
   */
  private static allocateWebinarSlots(
    availableSlots: TimeSlot[],
    durationHours: number,
  ): TimeSlot[] {
    const requiredSlots = Math.ceil(durationHours * 2); // 30-minute intervals

    if (requiredSlots === 1) {
      return this.allocateConsultationSlots(availableSlots, durationHours);
    }

    // Find consecutive slots
    const sortedSlots = availableSlots.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    for (let i = 0; i <= sortedSlots.length - requiredSlots; i++) {
      const consecutiveSlots = [];
      let isConsecutive = true;

      // Check if we have enough consecutive slots starting from this position
      for (let j = 0; j < requiredSlots; j++) {
        const currentSlot = sortedSlots[i + j];
        if (!currentSlot) {
          isConsecutive = false;
          break;
        }

        if (j > 0) {
          const prevSlot = consecutiveSlots[j - 1];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            isConsecutive = false;
            break;
          }
        }

        consecutiveSlots.push(currentSlot);
      }

      if (isConsecutive && consecutiveSlots.length === requiredSlots) {
        return consecutiveSlots;
      }
    }

    return []; // No consecutive slots found
  }

  /**
   * Allocate slots for recurring events (subscriptions/classes).
   * Distributes calls across weeks, respecting sessionsPerWeek limits.
   * Returns an array of 30-minute TimeSlot objects.
   */
  private static allocateRecurringSlots(
    availableSlots: TimeSlot[],
    totalSlots: number,
    sessionsPerWeek: number,
    options: AllocationOptions,
  ): TimeSlot[] {
    if (!options.startDate || !options.endDate) {
      return [];
    }

    const sessionDurationInHours = options.sessionDurationInHours || 1;
    const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);
    // Per-day session cap — mirror the manual interactive guard
    // (useSlotAllocation: subscription maxCallsPerDay=1, class maxSessionsPerDay=2)
    // so auto-allocate produces a schedule a consultant could also create by hand.
    const maxCallsPerDay =
      options.eventType === "class"
        ? options.maxSessionsPerDay ?? 2
        : options.maxCallsPerDay ?? 1;
    // FIX: Track 30-min slot count correctly. Previously, slotsNeededThisWeek
    // counted calls but was compared against totalSlots (30-min slot count),
    // and the final split always produced exactly 2 slots per selected block
    // regardless of session duration. Now we track calls and convert properly.
    const totalCallsNeeded = Math.floor(totalSlots / slotsPerCall);
    const hoursPerCall = Math.ceil(sessionDurationInHours);

    const sortedAvailableSlots = availableSlots.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    const futureSlots = sortedAvailableSlots.filter((slot) => {
      const startsAfterOrOnBegin =
        slot.startTime.getTime() >= options.startDate!.getTime();
      const endsBeforeOrOnEnd =
        slot.endTime.getTime() <= options.endDate!.getTime();
      return startsAfterOrOnBegin && endsBeforeOrOnEnd;
    });

    // Group slots by scheduling-timezone week (ADR B9)
    const slotsByWeek = SlotCalculationService.groupSlotsByWeek(
      futureSlots,
      options.schedulingTimezone ??
        SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE,
    );

    const sortedWeeks = Array.from(slotsByWeek.keys()).sort();
    const totalWeeks = countSundayWeeksInclusive(
      options.startDate,
      options.endDate,
    );

    // Allocate calls week by week
    const selectedCalls: TimeSlot[][] = [];
    let currentWeek = 0;

    for (const weekKey of sortedWeeks) {
      if (
        selectedCalls.length >= totalCallsNeeded ||
        currentWeek >= totalWeeks
      ) {
        break;
      }

      const weekSlots = slotsByWeek.get(weekKey)!;
      const callsNeededThisWeek = Math.min(
        sessionsPerWeek,
        totalCallsNeeded - selectedCalls.length,
      );

      // Sort slots by preference
      const preferredSlots = this.sortSlotsByPreference(weekSlots);

      // For each call needed this week, find a consecutive block of availability
      const callsThisWeek = this.selectCallsFromWeek(
        preferredSlots,
        callsNeededThisWeek,
        hoursPerCall,
        slotsPerCall,
        MIN_HOURS_BETWEEN_SAME_DAY_SESSIONS,
        maxCallsPerDay,
        options.schedulingTimezone,
      );

      selectedCalls.push(...callsThisWeek);
      currentWeek++;
    }

    // Flatten all calls into a single array of 30-min slots
    return selectedCalls.flat();
  }

  /**
   * Select multiple calls from a week's available slots, each requiring
   * consecutive 1-hour blocks to cover the session duration.
   * Returns an array of call groups, each being an array of 30-min slots.
   */
  private static selectCallsFromWeek(
    weekSlots: TimeSlot[],
    callsNeeded: number,
    hoursPerCall: number,
    slotsPerCall: number,
    minHoursBetween: number,
    maxCallsPerDay: number,
    schedulingTimezone?: string,
  ): TimeSlot[][] {
    const calls: TimeSlot[][] = [];
    const usedSlotIndices = new Set<number>();
    // Calls already placed per scheduling-timezone day; must use the same key
    // as the manual interactive guard AND the server's per-day cap (ADR B9).
    const callsPerDay = new Map<string, number>();
    const minMsBetween = minHoursBetween * 60 * 60 * 1000;

    const sortedSlots = [...weekSlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    for (let i = 0; i <= sortedSlots.length - slotsPerCall; i++) {
      if (calls.length >= callsNeeded) break;
      if (usedSlotIndices.has(i)) continue;

      // Try to find `slotsPerCall` consecutive 30-min slots starting at i
      const blockIndices: number[] = [];
      let isConsecutive = true;

      for (let j = 0; j < slotsPerCall; j++) {
        const idx = i + j;
        if (idx >= sortedSlots.length || usedSlotIndices.has(idx)) {
          isConsecutive = false;
          break;
        }
        if (j > 0) {
          const prevSlot = sortedSlots[i + j - 1];
          const curSlot = sortedSlots[idx];
          if (curSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            isConsecutive = false;
            break;
          }
        }
        blockIndices.push(idx);
      }

      if (!isConsecutive || blockIndices.length < slotsPerCall) continue;

      const blockStart = sortedSlots[blockIndices[0]].startTime;

      // Per-day cap (subscription 1/day, class 2/day), bucketed by the
      // event's scheduling timezone — the same key
      // SlotValidationService.validatePerDaySessionCap uses, so auto-picked
      // schedules can't be rejected server-side.
      const dayKey = SlotCalculationService.dayKey(
        blockStart,
        schedulingTimezone,
      );
      if ((callsPerDay.get(dayKey) || 0) >= maxCallsPerDay) continue;

      // Check spacing against already selected calls
      const hasConflict = calls.some((existingCall) => {
        const existingStart = existingCall[0].startTime;
        return (
          Math.abs(blockStart.getTime() - existingStart.getTime()) <
          minMsBetween
        );
      });
      if (hasConflict) continue;

      // Generate exactly `slotsPerCall` 30-min slots from this block
      const thirtyMinSlots: TimeSlot[] = [];
      for (let k = 0; k < slotsPerCall; k++) {
        const slotStart = new Date(blockStart.getTime() + k * 30 * 60000);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60000);
        thirtyMinSlots.push({
          ...sortedSlots[blockIndices[0]],
          startTime: slotStart,
          endTime: slotEnd,
        });
      }

      calls.push(thirtyMinSlots);
      blockIndices.forEach((idx) => usedSlotIndices.add(idx));
      callsPerDay.set(dayKey, (callsPerDay.get(dayKey) || 0) + 1);
    }

    return calls;
  }

  /**
   * Enhanced slot preference sorting
   */
  private static sortSlotsByPreference(slots: TimeSlot[]): TimeSlot[] {
    return slots.sort((a, b) => {
      // Prefer weekdays over weekends
      const aIsWeekday = this.isWeekday(a.startTime);
      const bIsWeekday = this.isWeekday(b.startTime);

      if (aIsWeekday !== bIsWeekday) {
        return aIsWeekday ? -1 : 1;
      }

      // Prefer optimal time ranges
      const aHour = a.startTime.getHours();
      const bHour = b.startTime.getHours();

      const aScore = this.getTimeScore(aHour);
      const bScore = this.getTimeScore(bHour);

      if (aScore !== bScore) {
        return bScore - aScore; // Higher score is better
      }

      // Prefer earlier days in the week
      const aDayScore = this.getDayScore(a.startTime.getDay());
      const bDayScore = this.getDayScore(b.startTime.getDay());

      if (aDayScore !== bDayScore) {
        return bDayScore - aDayScore;
      }

      // Finally, sort by time
      return a.startTime.getTime() - b.startTime.getTime();
    });
  }

  /**
   * Check if a date is a weekday
   */
  private static isWeekday(date: Date): boolean {
    const day = date.getDay();
    return day >= 1 && day <= 5; // Monday to Friday
  }

  /**
   * Get preference score for a given hour (0-23)
   */
  private static getTimeScore(hour: number): number {
    if (hour >= 10 && hour <= 16) {
      return 10; // Prime business hours (10 AM - 4 PM)
    } else if (hour >= 9 && hour <= 17) {
      return 8; // Good business hours (9 AM - 5 PM)
    } else if (hour >= 8 && hour <= 18) {
      return 6; // Extended business hours (8 AM - 6 PM)
    } else if (hour >= 19 && hour <= 21) {
      return 4; // Evening hours (7 PM - 9 PM)
    } else {
      return 1; // Early morning or late evening
    }
  }

  /**
   * Get preference score for day of week
   */
  private static getDayScore(day: number): number {
    switch (day) {
      case 2: // Tuesday
      case 3: // Wednesday
      case 4: // Thursday
        return 10; // Best days
      case 1: // Monday
      case 5: // Friday
        return 8; // Good days
      case 6: // Saturday
        return 3; // Weekend but acceptable
      case 0: // Sunday
        return 1; // Least preferred
      default:
        return 1;
    }
  }
}
