"use client";

import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface ProfileCompletionIndicatorProps {
  percentage: number;
  missingFields?: string[];
  className?: string;
  showMissingFields?: boolean;
  variant?: "default" | "compact";
}

export function ProfileCompletionIndicator({
  percentage,
  missingFields = [],
  className,
  showMissingFields = true,
  variant = "default",
}: ProfileCompletionIndicatorProps) {
  const isComplete = percentage >= 100;

  if (variant === "compact") {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <Progress value={percentage} className="h-2 w-24" />
        <span
          className={cn(
            "text-sm font-medium",
            isComplete ? "text-emerald-600" : "text-zinc-600"
          )}
        >
          {percentage}%
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        isComplete
          ? "bg-emerald-50 border-emerald-200"
          : "bg-amber-50 border-amber-200",
        className
      )}
    >
      <div className="flex items-start gap-3">
        {isComplete ? (
          <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
        ) : (
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-4 mb-2">
            <h4
              className={cn(
                "font-medium",
                isComplete ? "text-emerald-800" : "text-amber-800"
              )}
            >
              {isComplete ? "Profile Complete" : "Complete Your Profile"}
            </h4>
            <span
              className={cn(
                "text-sm font-semibold",
                isComplete ? "text-emerald-700" : "text-amber-700"
              )}
            >
              {percentage}%
            </span>
          </div>
          <Progress
            value={percentage}
            className={cn(
              "h-2",
              isComplete
                ? "[&>div]:bg-emerald-500"
                : "[&>div]:bg-amber-500"
            )}
          />
          {showMissingFields && missingFields.length > 0 && (
            <div className="mt-3">
              <p className="text-sm text-amber-700 font-medium mb-1">
                Missing requirements:
              </p>
              <ul className="space-y-1">
                {missingFields.map((field, index) => (
                  <li
                    key={index}
                    className="text-sm text-amber-600 flex items-center gap-2"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                    {field}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
