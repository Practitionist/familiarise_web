"use client";

import React, { useMemo } from "react";
import {
  validateAllSlotsDetailed,
  getSlotStatistics,
} from "@/utils/timeSlotValidation";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SlotsType, ValidationFeedback } from "@/utils/schedule/types";

interface SlotValidationFeedbackProps {
  slots: SlotsType;
  className?: string;
  maxErrorsToShow?: number;
}

/**
 * Displays a summary banner with slot count, total duration, and any validation
 * errors. Renders nothing when no slots exist. Used in both the onboarding
 * schedule form and the dashboard settings form.
 */
export function SlotValidationFeedback({
  slots,
  className = "",
  maxErrorsToShow = 3,
}: SlotValidationFeedbackProps) {
  const feedback = useMemo((): ValidationFeedback => {
    const validation = validateAllSlotsDetailed(slots);
    const stats = getSlotStatistics(slots);

    return {
      ...validation,
      ...stats,
      hasSlots: Object.keys(slots).length > 0,
    };
  }, [slots]);

  // Don't render if no slots have been added
  if (!feedback.hasSlots) {
    return null;
  }

  return (
    <div className={`p-3 rounded-lg bg-muted/50 border ${className}`}>
      <div className="flex items-center justify-between">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-sm text-muted-foreground cursor-help">
                {feedback.validSlots} valid slot
                {feedback.validSlots !== 1 ? "s" : ""}
                {feedback.totalDurationHours > 0 &&
                  ` (${feedback.totalDurationHours}h total)`}
                {feedback.overnightSlots > 0 &&
                  `, ${feedback.overnightSlots} overnight`}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Slots with no time conflicts and valid start/end times</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {feedback.isValid ? (
          <span className="text-sm text-green-600 dark:text-green-400">
            Ready to proceed
          </span>
        ) : (
          <span className="text-sm text-destructive">
            {feedback.errors.length} error
            {feedback.errors.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      {!feedback.isValid && feedback.errors.length > 0 && (
        <div className="mt-2 space-y-1">
          {feedback.errors.slice(0, maxErrorsToShow).map((error, index) => (
            <div key={index} className="text-xs text-destructive">
              • {error}
            </div>
          ))}
          {feedback.errors.length > maxErrorsToShow && (
            <div className="text-xs text-muted-foreground">
              ...and {feedback.errors.length - maxErrorsToShow} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Hook to get validation feedback for slots.
 * Useful when you need the feedback data without rendering the component.
 */
export function useSlotValidationFeedback(
  slots: SlotsType,
): ValidationFeedback {
  return useMemo(() => {
    const validation = validateAllSlotsDetailed(slots);
    const stats = getSlotStatistics(slots);

    return {
      ...validation,
      ...stats,
      hasSlots: Object.keys(slots).length > 0,
    };
  }, [slots]);
}
