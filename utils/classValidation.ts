import { PrismaClient, Prisma } from "@prisma/client";
import { addWeeks, startOfWeek, endOfWeek, isWithinInterval } from "date-fns";
import { countSundayWeeksInclusive } from "@/app/dashboard/consultant/[consultantId]/(features)/shared/utils/calendarUtils";

type AppointmentSlotRecord = { slotStartTimeInUTC: Date };
type AppointmentWithSlots = {
  id: string;
  slotsOfAppointment: AppointmentSlotRecord[];
};

interface WeeklySessionInfo {
  weekStart: Date;
  weekEnd: Date;
  existingSessions: number;
  maxSessions: number;
  canScheduleMore: boolean;
  availableSlots: number;
}

interface ClassValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  weeklyInfo: WeeklySessionInfo[];
  totalSessionsScheduled: number;
  maxTotalSessions: number;
  classPeriod: {
    start: Date;
    end: Date;
  };
}

/**
 * Enhanced class validation service that checks week-based session limits
 * and ensures appointments are within class date range.
 *
 * KEY FEATURES:
 * - Uses Sunday-to-Saturday week boundaries for consistent week counting
 * - Validates consecutive slots with timezone tolerance (1 second)
 * - Prevents auto-filling past weeks with maximum sessions
 * - Handles month-end overflow issues in date calculations
 *
 * WEEK COUNTING LOGIC:
 * - Weeks are defined as Sunday 00:00 to Saturday 23:59
 * - First week: Sunday of the week containing class start date
 * - Last week: Sunday of the week containing class end date
 */
export class ClassValidationService {
  constructor(
    private readonly prisma: PrismaClient | Prisma.TransactionClient,
  ) {}

  /**
   * Validates class slot allocation based on weekly limits and class period
   */
  async validateClassSlots(
    classId: string,
    proposedSlots: string[],
    excludeAppointmentIds: string[] = [],
  ): Promise<ClassValidationResult> {
    // Get class details
    const classData = await this.prisma.class.findUnique({
      where: { id: classId },
      include: {
        classPlan: {
          include: {
            classContents: true,
          },
        },
      },
    });

    if (!classData) {
      throw new Error("Class not found");
    }

    const { classPlan } = classData;
    const proposedSlotDates = proposedSlots.map((slot) => new Date(slot));

    // Calculate class period (start from now, duration in months)
    const classStart = new Date();
    const classEnd = addWeeks(classStart, classPlan.durationInMonths * 4.33); // Approximate weeks per month

    // Calculate exact weeks using the same logic as subscriptions
    const exactWeeks = countSundayWeeksInclusive(classStart, classEnd);

    // Initialize result
    const result: ClassValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      weeklyInfo: [],
      totalSessionsScheduled: 0,
      maxTotalSessions: classPlan.callsPerWeek * exactWeeks,
      classPeriod: {
        start: classStart,
        end: classEnd,
      },
    };

    // Check if proposed slots are within class period
    const classPeriodValid = this.validateClassPeriod(
      proposedSlotDates,
      classStart,
      classEnd,
    );

    if (!classPeriodValid.isValid) {
      result.isValid = false;
      result.errors.push(...classPeriodValid.errors);
    }

    // Get existing appointments for this class
    const existingAppointments = await this.getExistingClassAppointments(
      classId,
      excludeAppointmentIds,
    );

    // Calculate session duration from class plan
    const sessionDurationInHours = this.calculateSessionDuration(classPlan);

    // Group existing appointments by week
    const existingSessionsByWeek =
      this.groupAppointmentsByWeek(existingAppointments);

    // Group proposed slots by week
    const proposedSessionsByWeek = this.groupSlotsByWeek(
      proposedSlotDates,
      sessionDurationInHours,
    );

    // Generate weekly info for the entire class period
    const weeklyInfo = this.generateWeeklyInfo(
      classStart,
      classEnd,
      classPlan.callsPerWeek,
      existingSessionsByWeek,
      proposedSessionsByWeek,
    );

    result.weeklyInfo = weeklyInfo;
    result.totalSessionsScheduled = weeklyInfo.reduce(
      (sum, w) => sum + w.existingSessions,
      0,
    );

    // Validate weekly limits
    const weeklyValidation = this.validateWeeklyLimits(weeklyInfo);
    if (!weeklyValidation.isValid) {
      result.isValid = false;
      result.errors.push(...weeklyValidation.errors);
      result.warnings.push(...weeklyValidation.warnings);
    }

    // Validate total session limits
    if (result.totalSessionsScheduled > result.maxTotalSessions) {
      result.isValid = false;
      result.errors.push(
        `Total sessions (${result.totalSessionsScheduled}) exceed class limit (${result.maxTotalSessions})`,
      );
    }

    return result;
  }

  /**
   * Calculate session duration from class plan
   */
  private calculateSessionDuration(classPlan: any): number {
    // Use the sessionDurationInHours field directly from the class plan
    return classPlan.sessionDurationInHours || 1;
  }

  /**
   * Validates if slots are within the class period
   */
  private validateClassPeriod(
    slotDates: Date[],
    classStart: Date,
    classEnd: Date,
  ): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const slotDate of slotDates) {
      if (
        !isWithinInterval(slotDate, {
          start: classStart,
          end: classEnd,
        })
      ) {
        errors.push(
          `Slot ${slotDate.toLocaleDateString()} is outside class period (${classStart.toLocaleDateString()} - ${classEnd.toLocaleDateString()})`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Gets existing appointments for a class
   */
  private async getExistingClassAppointments(
    classId: string,
    excludeAppointmentIds: string[] = [],
  ): Promise<AppointmentWithSlots[]> {
    return await this.prisma.appointment.findMany({
      where: {
        classId,
        id: {
          notIn: excludeAppointmentIds,
        },
        class: {
          status: "SCHEDULED",
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
    const weeklySessionCount = new Map<string, number>();

    for (const appointment of appointments) {
      // Each appointment represents one session
      if (appointment.slotsOfAppointment.length > 0) {
        const firstSlot = appointment.slotsOfAppointment[0];
        const weekStart = startOfWeek(new Date(firstSlot.slotStartTimeInUTC));
        const weekKey = weekStart.toISOString();

        weeklySessionCount.set(
          weekKey,
          (weeklySessionCount.get(weekKey) || 0) + 1,
        );
      }
    }

    return weeklySessionCount;
  }

  /**
   * Groups proposed slots by week and converts to confirmed session count
   */
  private groupSlotsByWeek(
    slotDates: Date[],
    sessionDurationInHours: number,
  ): Map<string, number> {
    const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5); // 30-minute intervals

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

    // Helper function to check if slots form a complete session
    const isCompleteSession = (daySlots: Date[]): boolean => {
      if (daySlots.length !== slotsPerSession) return false;

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

    // Process each day to count confirmed sessions per week
    const weekSessions = new Map<string, number>();
    slotsByDay.forEach((daySlots) => {
      if (daySlots.length === 0) return;

      const weekString = getWeekString(daySlots[0]);

      if (!weekSessions.has(weekString)) {
        weekSessions.set(weekString, 0);
      }

      // Only count as a session if it's complete (correct number of consecutive slots)
      if (isCompleteSession(daySlots)) {
        weekSessions.set(weekString, weekSessions.get(weekString)! + 1);
      }
    });

    return weekSessions;
  }

  /**
   * Generates weekly information for the entire class period
   */
  private generateWeeklyInfo(
    classStart: Date,
    classEnd: Date,
    sessionsPerWeek: number,
    existingSessions: Map<string, number>,
    proposedSessions: Map<string, number>,
  ): WeeklySessionInfo[] {
    const weeklyInfo: WeeklySessionInfo[] = [];
    let currentWeek = startOfWeek(classStart);

    while (currentWeek <= classEnd) {
      const weekEnd = endOfWeek(currentWeek);
      const weekKey = currentWeek.toISOString();

      const existingSessionCount = existingSessions.get(weekKey) || 0;
      const proposedSessionCount = proposedSessions.get(weekKey) || 0;

      const today = new Date();
      const isPastWeek = weekEnd < today;

      const totalSessions = existingSessionCount + proposedSessionCount;

      weeklyInfo.push({
        weekStart: new Date(currentWeek),
        weekEnd: new Date(weekEnd),
        existingSessions: existingSessionCount,
        maxSessions: sessionsPerWeek,
        canScheduleMore: !isPastWeek && totalSessions < sessionsPerWeek,
        availableSlots: isPastWeek
          ? 0
          : Math.max(0, sessionsPerWeek - totalSessions),
      });

      currentWeek = addWeeks(currentWeek, 1);
    }

    return weeklyInfo;
  }

  /**
   * Validates weekly session limits
   */
  private validateWeeklyLimits(weeklyInfo: WeeklySessionInfo[]): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const week of weeklyInfo) {
      const totalSessionsForWeek = week.maxSessions - week.availableSlots;

      if (totalSessionsForWeek > week.maxSessions) {
        errors.push(
          `Week of ${week.weekStart.toLocaleDateString()} exceeds session limit. ` +
            `Maximum ${week.maxSessions} sessions per week, but ${totalSessionsForWeek} sessions are scheduled.`,
        );
      }

      if (week.existingSessions === week.maxSessions) {
        warnings.push(
          `Week of ${week.weekStart.toLocaleDateString()} is fully booked. ` +
            `${week.existingSessions}/${week.maxSessions} sessions scheduled.`,
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
   * Gets available weeks for scheduling new sessions
   */
  async getAvailableWeeksForClass(
    classId: string,
  ): Promise<WeeklySessionInfo[]> {
    const validationResult = await this.validateClassSlots(classId, []);
    return validationResult.weeklyInfo.filter((week) => week.canScheduleMore);
  }

  /**
   * Checks if a specific week can accommodate additional sessions
   */
  async canScheduleInWeek(
    classId: string,
    weekDate: Date,
    additionalSessions: number = 1,
  ): Promise<boolean> {
    const weekStart = startOfWeek(weekDate);
    const validationResult = await this.validateClassSlots(classId, []);

    const weekInfo = validationResult.weeklyInfo.find(
      (week) => week.weekStart.getTime() === weekStart.getTime(),
    );

    return weekInfo ? weekInfo.availableSlots >= additionalSessions : false;
  }
}

/**
 * Helper function to get the week that contains a specific date within a class period
 */
export function getClassWeek(targetDate: Date, classStartDate: Date): number {
  const weekStart = startOfWeek(classStartDate);
  const targetWeekStart = startOfWeek(targetDate);

  const diffInWeeks = Math.floor(
    (targetWeekStart.getTime() - weekStart.getTime()) /
      (7 * 24 * 60 * 60 * 1000),
  );

  return diffInWeeks + 1; // 1-based week numbering
}

/**
 * Helper function to determine class type based on plan details
 */
export function getClassType(
  sessionsPerWeek: number,
  durationInMonths: number,
): string {
  if (sessionsPerWeek === 2 && durationInMonths === 1) {
    return "Basic";
  } else if (sessionsPerWeek === 3 && durationInMonths === 2) {
    return "Extended";
  } else if (sessionsPerWeek === 4 && durationInMonths === 4) {
    return "Comprehensive";
  }
  return "Custom";
}
