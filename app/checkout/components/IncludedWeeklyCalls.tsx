"use client";

import React, { useMemo } from "react";
import { getWeeklyCallCount } from "@/utils/subscription";

function addOneMonth(date: Date): Date {
  const d = new Date(date);
  const month = d.getMonth();
  d.setMonth(month + 1);
  // Handle cases where adding a month overflows (e.g., Jan 31 -> Mar 3)
  if (d.getMonth() === (month + 2) % 12) {
    d.setDate(0); // move to last day of previous month
  }
  return d;
}

type IncludedWeeklyCallsProps = Readonly<{
  startDate?: Date | string;
  endDate?: Date | string;
  className?: string;
  minWeeks?: number; // optional UI guardrail
  maxWeeks?: number; // optional UI guardrail
}>;

export default function IncludedWeeklyCalls({
  startDate,
  endDate,
  className,
  minWeeks = 1,
  maxWeeks = 6,
}: IncludedWeeklyCallsProps) {
  const { calls, error, warnings } = useMemo(() => {
    // Resolve dates
    const resolvedStart = startDate ? new Date(startDate) : new Date();
    const resolvedEnd = endDate
      ? new Date(endDate)
      : addOneMonth(resolvedStart);

    // Basic validity checks
    if (isNaN(resolvedStart.getTime()) || isNaN(resolvedEnd.getTime())) {
      return {
        calls: 0,
        error: "Invalid start or end date.",
        warnings: [] as string[],
      };
    }

    if (resolvedEnd < resolvedStart) {
      return {
        calls: 0,
        error: "End date cannot be earlier than start date.",
        warnings: [] as string[],
      };
    }

    let calls: number;
    try {
      calls = getWeeklyCallCount(resolvedStart, resolvedEnd);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unable to compute weekly calls.";
      return {
        calls: 0,
        error: message,
        warnings: [] as string[],
      };
    }

    const warnings: string[] = [];
    if (calls < minWeeks) {
      warnings.push(
        `Selected range is too short. At least ${minWeeks} week(s) expected.`,
      );
    }
    if (calls > maxWeeks) {
      warnings.push(
        `Selected range is quite long. Typically ${maxWeeks} week(s) max for a monthly plan.`,
      );
    }

    return { calls, error: "", warnings };
  }, [startDate, endDate, minWeeks, maxWeeks]);

  if (error) {
    return (
      <div className={className}>
        <p className="text-sm text-red-500">{error}</p>
      </div>
    );
  }

  return (
    <div className={className}>
      <p className="text-sm text-muted-foreground">
        Included weekly calls:{" "}
        <span className="font-medium text-foreground">{calls}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        Weeks counted from the Sunday of the start week to the Saturday of the
        end week.
      </p>
      {warnings.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-amber-600">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
