import { useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";

/* interface TimeSlot {
  startTime: Date;
  endTime: Date;
} */

interface WeeklyCallInfo {
  weekStart: Date;
  weekEnd: Date;
  existingCalls: number;
  proposedCalls: number;
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

interface UseSubscriptionValidationOptions {
  subscriptionId: string;
  callsPerWeek: number;
  durationInMonths: number;
  sessionDurationInHours: number;
}

interface UseSubscriptionValidationReturn {
  validateSlots: (slots: string[]) => Promise<SubscriptionValidationResult>;
  getAvailableWeeks: () => Promise<WeeklyCallInfo[]>;
  canScheduleInWeek: (
    weekDate: Date,
    additionalCalls?: number,
  ) => Promise<boolean>;
  isValidating: boolean;
  lastValidationResult: SubscriptionValidationResult | null;
  getSubscriptionType: () => string;
}

/**
 * Hook for subscription-specific slot validation with enhanced week-based logic
 */
export function useSubscriptionValidation(
  options: UseSubscriptionValidationOptions,
): UseSubscriptionValidationReturn {
  const { toast } = useToast();
  const [isValidating, setIsValidating] = useState(false);
  const [lastValidationResult, setLastValidationResult] =
    useState<SubscriptionValidationResult | null>(null);

  const { subscriptionId, callsPerWeek, durationInMonths } = options;

  /**
   * Validates proposed slots against subscription rules
   */
  const validateSlots = useCallback(
    async (slots: string[]): Promise<SubscriptionValidationResult> => {
      setIsValidating(true);

      try {
        const response = await fetch(
          `/api/events/subscriptions/${subscriptionId}/validate`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ slots }),
          },
        );

        if (!response.ok) {
          throw new Error(`Validation failed: ${response.statusText}`);
        }

        const data = await response.json();
        const validationResult = data.data?.subscriptionValidation;

        if (!validationResult) {
          throw new Error("No subscription validation data received");
        }

        setLastValidationResult(validationResult);

        // Show user-friendly messages
        if (!validationResult.isValid) {
          toast({
            variant: "destructive",
            title: "Subscription Validation Failed",
            description: validationResult.errors.join("; "),
          });
        } else if (validationResult.warnings.length > 0) {
          toast({
            variant: "warning",
            title: "Subscription Validation Warnings",
            description: validationResult.warnings.join("; "),
          });
        }

        return validationResult;
      } catch (error) {
        console.error("Subscription validation error:", error);
        const errorMessage =
          error instanceof Error ? error.message : "Validation failed";

        toast({
          variant: "destructive",
          title: "Validation Error",
          description: errorMessage,
        });

        // Return a failed validation result
        const failedResult: SubscriptionValidationResult = {
          isValid: false,
          errors: [errorMessage],
          warnings: [],
          weeklyInfo: [],
          totalCallsScheduled: 0,
          maxTotalCalls: callsPerWeek * durationInMonths * 4,
          subscriptionPeriod: {
            start: new Date(),
            end: new Date(),
          },
        };

        setLastValidationResult(failedResult);
        return failedResult;
      } finally {
        setIsValidating(false);
      }
    },
    [subscriptionId, callsPerWeek, durationInMonths, toast],
  );

  /**
   * Gets available weeks for scheduling new calls
   */
  const getAvailableWeeks = useCallback(async (): Promise<WeeklyCallInfo[]> => {
    try {
      const validationResult = await validateSlots([]);
      return validationResult.weeklyInfo.filter((week) => week.canScheduleMore);
    } catch (error) {
      console.error("Error getting available weeks:", error);
      return [];
    }
  }, [validateSlots]);

  /**
   * Checks if a specific week can accommodate additional calls
   */
  const canScheduleInWeek = useCallback(
    async (weekDate: Date, additionalCalls: number = 1): Promise<boolean> => {
      try {
        const validationResult = await validateSlots([]);
        const weekStart = new Date(weekDate);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Get start of week (Sunday)

        const weekInfo = validationResult.weeklyInfo.find(
          (week) => week.weekStart.getTime() === weekStart.getTime(),
        );

        return weekInfo ? weekInfo.availableSlots >= additionalCalls : false;
      } catch (error) {
        console.error("Error checking week availability:", error);
        return false;
      }
    },
    [validateSlots],
  );

  /**
   * Determines the subscription type based on plan details
   */
  const getSubscriptionType = useCallback((): string => {
    if (callsPerWeek === 1 && durationInMonths === 1) {
      return "Basic";
    } else if (callsPerWeek === 2 && durationInMonths === 2) {
      return "Extended";
    } else if (callsPerWeek === 3 && durationInMonths === 6) {
      return "Comprehensive";
    }
    return "Custom";
  }, [callsPerWeek, durationInMonths]);

  return {
    validateSlots,
    getAvailableWeeks,
    canScheduleInWeek,
    isValidating,
    lastValidationResult,
    getSubscriptionType,
  };
}

/**
 * Helper function to check if a date is within a specific week
 */
export function isDateInWeek(date: Date, weekStart: Date): boolean {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  return date >= weekStart && date <= weekEnd;
}

/**
 * Helper function to get week boundaries for a given date
 */
export function getWeekBoundaries(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay()); // Sunday
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 6); // Saturday
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Helper function to format subscription validation errors for display
 */
export function formatSubscriptionErrors(errors: string[]): string {
  if (errors.length === 0) return "";

  if (errors.length === 1) return errors[0];

  const formattedErrors = errors
    .map((error, index) => `${index + 1}. ${error}`)
    .join("\n");
  return `Multiple issues found:\n${formattedErrors}`;
}

/**
 * Helper function to get user-friendly week descriptions
 */
export function getWeekDescription(weekStart: Date): string {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const startMonth = weekStart.toLocaleDateString("en-US", { month: "short" });
  const endMonth = weekEnd.toLocaleDateString("en-US", { month: "short" });

  if (startMonth === endMonth) {
    return `${startMonth} ${weekStart.getDate()}-${weekEnd.getDate()}`;
  } else {
    return `${startMonth} ${weekStart.getDate()} - ${endMonth} ${weekEnd.getDate()}`;
  }
}
