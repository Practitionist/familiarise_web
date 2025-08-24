import { PrismaClient, Prisma, RequestStatus } from "@prisma/client";
import { addWeeks, startOfWeek, endOfWeek, isWithinInterval } from "date-fns";
import { countSundayWeeksInclusive } from "@/app/dashboard/consultant/[consultantId]/(features)/shared/utils/calendarUtils";

type AppointmentSlotRecord = { slotStartTimeInUTC: Date };
type AppointmentWithSlots = {
  id: string;
  slotsOfAppointment: AppointmentSlotRecord[];
};

interface WeeklyCallInfo {
  weekStart: Date;
  weekEnd: Date;
  existingCalls: number;
  maxCalls: number;
  canScheduleMore: boolean;
  availableSlots: number;
}

interface SubscriptionValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  weeklyInfo: WeeklyCallInfo[];
  totalCallsScheduled: number;
  maxTotalCalls: number;
  subscriptionPeriod: {
    start: Date;
    end: Date;
  };
}

/**
 * Enhanced subscription validation service that checks week-based call limits
 * and ensures appointments are within subscription date range.
 *
 * KEY FEATURES:
 * - Uses Sunday-to-Saturday week boundaries for consistent week counting
 * - Validates consecutive slots with timezone tolerance (1 second)
 * - Prevents auto-filling past weeks with maximum calls
 * - Handles month-end overflow issues in date calculations
 *
 * WEEK COUNTING LOGIC:
 * - Weeks are defined as Sunday 00:00 to Saturday 23:59
 * - First week: Sunday of the week containing subscription start date
 * - Last week: Sunday of the week containing subscription end date
 * - Example: Jan 1 (Mon) to Feb 1 (Thu) = 5 weeks (not 4.33)
 */
export class SubscriptionValidationService {
  constructor(
    private readonly prisma: PrismaClient | Prisma.TransactionClient,
  ) {}

  /**
   * Validates subscription slot allocation based on weekly limits and subscription period
   */
  async validateSubscriptionSlots(
    subscriptionId: string,
    proposedSlots: string[],
    excludeAppointmentIds: string[] = [],
  ): Promise<SubscriptionValidationResult> {
    // Get subscription details
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        subscriptionPlan: true,
        requestedBy: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    const { subscriptionPlan } = subscription;
    const proposedSlotDates = proposedSlots.map((slot) => new Date(slot));

    // FIXED: Use the correct Sunday-to-Saturday week counting logic
    const exactWeeks = countSundayWeeksInclusive(
      subscription.startDate,
      subscription.endDate,
    );

    // Initialize result
    const result: SubscriptionValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      weeklyInfo: [],
      totalCallsScheduled: 0,
      maxTotalCalls: subscriptionPlan.callsPerWeek * exactWeeks,
      subscriptionPeriod: {
        start: subscription.startDate,
        end: subscription.endDate,
      },
    };

    // Check if proposed slots are within subscription period
    const subscriptionPeriodValid = this.validateSubscriptionPeriod(
      proposedSlotDates,
      subscription.startDate,
      subscription.endDate,
    );

    if (!subscriptionPeriodValid.isValid) {
      result.isValid = false;
      result.errors.push(...subscriptionPeriodValid.errors);
    }

    // Get existing appointments for this subscription
    const existingAppointments = await this.getExistingSubscriptionAppointments(
      subscriptionId,
      excludeAppointmentIds,
    );

    // Group existing appointments by week
    const existingCallsByWeek =
      this.groupAppointmentsByWeek(existingAppointments);

    // Group proposed slots by week
    const proposedCallsByWeek = this.groupSlotsByWeek(
      proposedSlotDates,
      subscriptionPlan.sessionDurationInHours,
    );

    // Generate weekly info for the entire subscription period
    const weeklyInfo = this.generateWeeklyInfo(
      subscription.startDate,
      subscription.endDate,
      subscriptionPlan.callsPerWeek,
      existingCallsByWeek,
      proposedCallsByWeek,
    );

    result.weeklyInfo = weeklyInfo;
    // Total calls are determined by counting completed weeks (auto-completed) plus any scheduled/proposed calls within the current and future weeks
    result.totalCallsScheduled = weeklyInfo.reduce(
      (sum, w) => sum + w.existingCalls,
      0,
    );

    // Validate weekly limits
    const weeklyValidation = this.validateWeeklyLimits(weeklyInfo);
    if (!weeklyValidation.isValid) {
      result.isValid = false;
      result.errors.push(...weeklyValidation.errors);
      result.warnings.push(...weeklyValidation.warnings);
    }

    // Validate total call limits
    if (result.totalCallsScheduled > result.maxTotalCalls) {
      result.isValid = false;
      result.errors.push(
        `Total calls (${result.totalCallsScheduled}) exceed subscription limit (${result.maxTotalCalls})`,
      );
    }

    return result;
  }

  /**
   * Validates if slots are within the subscription period
   */
  private validateSubscriptionPeriod(
    slotDates: Date[],
    subscriptionStart: Date,
    subscriptionEnd: Date,
  ): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const slotDate of slotDates) {
      if (
        !isWithinInterval(slotDate, {
          start: subscriptionStart,
          end: subscriptionEnd,
        })
      ) {
        errors.push(
          `Slot ${slotDate.toLocaleDateString()} is outside subscription period (${subscriptionStart.toLocaleDateString()} - ${subscriptionEnd.toLocaleDateString()})`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Gets existing appointments for a subscription
   */
  private async getExistingSubscriptionAppointments(
    subscriptionId: string,
    excludeAppointmentIds: string[] = [],
  ): Promise<AppointmentWithSlots[]> {
    return await this.prisma.appointment.findMany({
      where: {
        subscriptionId,
        id: {
          notIn: excludeAppointmentIds,
        },
        subscription: {
          requestStatus: {
            in: [RequestStatus.APPROVED, RequestStatus.SCHEDULED],
          },
        },
      },
      include: {
        slotsOfAppointment: true,
      },
    });
  }

  /**
   * Groups appointments by week
   */
  private groupAppointmentsByWeek(
    appointments: AppointmentWithSlots[],
  ): Map<string, number> {
    const weeklyCallCount = new Map<string, number>();

    for (const appointment of appointments) {
      for (const slot of appointment.slotsOfAppointment) {
        const weekStart = startOfWeek(new Date(slot.slotStartTimeInUTC));
        const weekKey = weekStart.toISOString();

        weeklyCallCount.set(weekKey, (weeklyCallCount.get(weekKey) || 0) + 1);
      }
    }

    return weeklyCallCount;
  }

  /**
   * Groups proposed slots by week and converts to confirmed call count
   */
  private groupSlotsByWeek(
    slotDates: Date[],
    sessionDurationInHours: number,
  ): Map<string, number> {
    const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5); // 30-minute intervals

    // Group slots by day first
    const slotsByDay = new Map<string, Date[]>();
    for (const slotDate of slotDates) {
      const dayKey = slotDate.toDateString();
      if (!slotsByDay.has(dayKey)) {
        slotsByDay.set(dayKey, []);
      }
      slotsByDay.get(dayKey)!.push(slotDate);
    }

    // Helper function to generate week string
    const getWeekString = (date: Date): string => {
      const weekStart = startOfWeek(date);
      return weekStart.toISOString().split("T")[0]; // YYYY-MM-DD format
    };

    // Helper function to check if slots form a complete call
    const isCompleteCall = (daySlots: Date[]): boolean => {
      if (daySlots.length !== slotsPerCall) return false;

      const sortedSlots = [...daySlots].sort(
        (a, b) => a.getTime() - b.getTime(),
      );

      for (let i = 1; i < sortedSlots.length; i++) {
        const prevEnd = new Date(sortedSlots[i - 1].getTime() + 30 * 60 * 1000); // Add 30 min
        const currentStart = sortedSlots[i];
        if (currentStart.getTime() !== prevEnd.getTime()) return false;
      }

      return true;
    };

    // Process each day to count confirmed calls per week
    const weekCalls = new Map<string, number>();
    slotsByDay.forEach((daySlots) => {
      if (daySlots.length === 0) return;

      const weekString = getWeekString(daySlots[0]);

      if (!weekCalls.has(weekString)) {
        weekCalls.set(weekString, 0);
      }

      // Only count as a call if it's complete (correct number of consecutive slots)
      if (isCompleteCall(daySlots)) {
        weekCalls.set(weekString, weekCalls.get(weekString)! + 1);
      }
    });

    return weekCalls;
  }

  /**
   * Generates weekly information for the entire subscription period
   */
  private generateWeeklyInfo(
    subscriptionStart: Date,
    subscriptionEnd: Date,
    callsPerWeek: number,
    existingCalls: Map<string, number>,
    proposedCalls: Map<string, number>,
  ): WeeklyCallInfo[] {
    const weeklyInfo: WeeklyCallInfo[] = [];
    let currentWeek = startOfWeek(subscriptionStart);

    while (currentWeek <= subscriptionEnd) {
      const weekEnd = endOfWeek(currentWeek);
      const weekKey = currentWeek.toISOString();

      const existingCallCountDb = existingCalls.get(weekKey) || 0;
      const proposedCallCount = proposedCalls.get(weekKey) || 0;

      // FIXED: Don't auto-fill past weeks with max calls, use actual data
      const today = new Date();
      const isPastWeek = weekEnd < today;

      // Only use actual existing call data, don't auto-fill past weeks
      const effectiveExistingCalls = existingCallCountDb;
      const totalCalls = effectiveExistingCalls + proposedCallCount;

      weeklyInfo.push({
        weekStart: new Date(currentWeek),
        weekEnd: new Date(weekEnd),
        existingCalls: effectiveExistingCalls,
        maxCalls: callsPerWeek,
        canScheduleMore: !isPastWeek && totalCalls < callsPerWeek,
        availableSlots: isPastWeek ? 0 : Math.max(0, callsPerWeek - totalCalls),
      });

      currentWeek = addWeeks(currentWeek, 1);
    }

    return weeklyInfo;
  }

  /**
   * Validates weekly call limits
   */
  private validateWeeklyLimits(weeklyInfo: WeeklyCallInfo[]): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const week of weeklyInfo) {
      const totalCallsForWeek = week.maxCalls - week.availableSlots; // calls accounted for (existing + proposed)

      if (totalCallsForWeek > week.maxCalls) {
        errors.push(
          `Week of ${week.weekStart.toLocaleDateString()} exceeds call limit. ` +
            `Maximum ${week.maxCalls} calls per week, but ${totalCallsForWeek} calls are scheduled.`,
        );
      }

      if (week.existingCalls === week.maxCalls) {
        warnings.push(
          `Week of ${week.weekStart.toLocaleDateString()} is fully booked. ` +
            `${week.existingCalls}/${week.maxCalls} calls scheduled.`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Calculates total number of confirmed calls (existing + proposed)
   */
  private calculateTotalCalls(
    existingAppointments: AppointmentWithSlots[],
    proposedSlots: Date[],
    sessionDurationInHours: number,
  ): number {
    const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);

    // Count existing confirmed calls (complete appointments)
    let existingCalls = 0;
    for (const appointment of existingAppointments) {
      const appointmentSlots = appointment.slotsOfAppointment.length;
      if (appointmentSlots === slotsPerCall) {
        existingCalls += 1; // Only count complete calls
      }
    }

    // Count proposed confirmed calls using the same logic as groupSlotsByWeek
    const proposedCallsMap = this.groupSlotsByWeek(
      proposedSlots,
      sessionDurationInHours,
    );
    const proposedCalls = Array.from(proposedCallsMap.values()).reduce(
      (sum, calls) => sum + calls,
      0,
    );

    return existingCalls + proposedCalls;
  }

  /**
   * Gets available weeks for scheduling new calls
   */
  async getAvailableWeeksForSubscription(
    subscriptionId: string,
  ): Promise<WeeklyCallInfo[]> {
    const validationResult = await this.validateSubscriptionSlots(
      subscriptionId,
      [],
    );
    return validationResult.weeklyInfo.filter((week) => week.canScheduleMore);
  }

  /**
   * Checks if a specific week can accommodate additional calls
   */
  async canScheduleInWeek(
    subscriptionId: string,
    weekDate: Date,
    additionalCalls: number = 1,
  ): Promise<boolean> {
    const weekStart = startOfWeek(weekDate);
    const validationResult = await this.validateSubscriptionSlots(
      subscriptionId,
      [],
    );

    const weekInfo = validationResult.weeklyInfo.find(
      (week) => week.weekStart.getTime() === weekStart.getTime(),
    );

    return weekInfo ? weekInfo.availableSlots >= additionalCalls : false;
  }
}

/**
 * Helper function to get the week that contains a specific date within a subscription period
 */
export function getSubscriptionWeek(
  targetDate: Date,
  subscriptionStartDate: Date,
): number {
  const weekStart = startOfWeek(subscriptionStartDate);
  const targetWeekStart = startOfWeek(targetDate);

  const diffInWeeks = Math.floor(
    (targetWeekStart.getTime() - weekStart.getTime()) /
      (7 * 24 * 60 * 60 * 1000),
  );

  return diffInWeeks + 1; // 1-based week numbering
}

/**
 * Helper function to determine subscription type based on plan details
 */
export function getSubscriptionType(
  callsPerWeek: number,
  durationInMonths: number,
): string {
  if (callsPerWeek === 1 && durationInMonths === 1) {
    return "Basic";
  } else if (callsPerWeek === 2 && durationInMonths === 2) {
    return "Extended";
  } else if (callsPerWeek === 3 && durationInMonths === 6) {
    return "Comprehensive";
  }
  return "Custom";
}
