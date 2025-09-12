"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { format } from "date-fns";
import {
  TimeSlot,
  validateDayBasedConsecutiveSlots,
} from "../utils/calendarUtils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

type EventType = "consultation" | "subscription" | "webinar" | "class";

export interface AllocationConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  selectedSlots: TimeSlot[];
  eventType: EventType;
  eventTitle?: string;
  consultantName?: string;
  durationInHours?: number;
  sessionDurationInHours?: number;
  callsPerWeek?: number;
  durationInMonths?: number;
  isAllocating?: boolean;
  timezone?: string; // IANA timezone (e.g., "Asia/Kolkata") for local display
  // Optional reschedule UI for subscriptions and classes
  rescheduleOptions?: Array<{ id: string; start: Date; end: Date }>;
  selectedRescheduleId?: string | null;
  onChangeSelectedRescheduleId?: (id: string) => void;
  // Additional props for handling expected calls
  expectedTotalCalls?: number; // Total number of calls/sessions expected for the subscription/class
}

export function AllocationConfirmationDialog(
  props: AllocationConfirmationDialogProps,
) {
  const {
    open,
    onOpenChange,
    onConfirm,
    onCancel,
    selectedSlots,
    eventType,
    eventTitle,
    consultantName,
    durationInHours,
    sessionDurationInHours,
    callsPerWeek,
    durationInMonths,
    isAllocating,
    timezone,
    rescheduleOptions = [],
    selectedRescheduleId,
    onChangeSelectedRescheduleId,
    expectedTotalCalls,
  } = props;

  const infoRows: Array<[string, string | number | undefined]> = [
    ["Event", eventTitle || eventType],
    ["Consultant", consultantName],
    ["Duration (hrs)", durationInHours],
    ["Session (hrs)", sessionDurationInHours],
    ["Calls per week", callsPerWeek],
    ["Duration (months)", durationInMonths],
    ["Selected slots", selectedSlots?.length ?? 0],
  ];

  // Compute slots-per-call/session based on event type
  const slotsPerCall = Math.ceil(
    (eventType === "consultation" || eventType === "webinar"
      ? durationInHours || 1
      : sessionDurationInHours || 1) / 0.5,
  );

  // Group slots by day and extract completed calls/sessions
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of selectedSlots) {
    const k = s.startTime.toDateString();
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(s);
  }

  type CompletedCall = { start: Date; end: Date };
  const completedCalls: CompletedCall[] = [];
  let hasInProgressCall = false;

  Array.from(byDay.values()).forEach((daySlots) => {
    const sorted = [...daySlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    if (eventType === "class") {
      // Classes: allow multiple sessions per day. Split consecutive runs and count full sessions.
      let runStartIndex = 0;
      for (let i = 1; i <= sorted.length; i++) {
        const isEnd = i === sorted.length;
        const prevEnd = !isEnd ? sorted[i - 1].endTime.getTime() : undefined;
        const currStart = !isEnd ? sorted[i].startTime.getTime() : undefined;
        const breaksRun = isEnd || currStart !== prevEnd;

        if (breaksRun) {
          const run = sorted.slice(runStartIndex, i);
          const fullSessions = Math.floor(run.length / slotsPerCall);
          for (let s = 0; s < fullSessions; s++) {
            const segStart = run[s * slotsPerCall].startTime;
            const segEnd = run[(s + 1) * slotsPerCall - 1].endTime;
            completedCalls.push({ start: segStart, end: segEnd });
          }
          if (run.length % slotsPerCall !== 0) {
            hasInProgressCall = true;
          }
          runStartIndex = i;
        }
      }
    } else {
      // Other events: single complete block per day
      if (
        sorted.length === slotsPerCall &&
        validateDayBasedConsecutiveSlots(sorted)
      ) {
        completedCalls.push({
          start: sorted[0].startTime,
          end: sorted[sorted.length - 1].endTime,
        });
      } else if (sorted.length > 0) {
        hasInProgressCall = true;
      }
    }
  });

  completedCalls.sort((a, b) => a.start.getTime() - b.start.getTime());

  const formatLocal = (d: Date) =>
    timezone
      ? d.toLocaleString(undefined, {
          timeZone: timezone,
          year: "numeric",
          month: "short",
          day: "2-digit",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : d.toLocaleString();

  // Generate scheduling options based on existing calls and expected total
  const hasExistingCalls = rescheduleOptions.length > 0;

  // Determine how many calls to show for scheduling selection.
  // Requirement: show according to plan per week (2 if plan has 2/week, 3 if 3/week, etc.).
  const planCallsPerWeek = callsPerWeek ?? expectedTotalCalls ?? 2;
  const totalExpectedCalls = hasExistingCalls
    ? Math.max(rescheduleOptions.length, planCallsPerWeek)
    : planCallsPerWeek;

  const isPartialSchedulingMode =
    (eventType === "subscription" || eventType === "class") &&
    hasExistingCalls &&
    rescheduleOptions.length < totalExpectedCalls;
  const isFullSchedulingMode =
    (eventType === "subscription" || eventType === "class") &&
    !hasExistingCalls;

  // Define types for scheduling options
  type ExistingCallOption = {
    id: string;
    label: string;
    isExisting: true;
    start: Date;
    end: Date;
  };

  type NewCallOption = {
    id: string;
    label: string;
    isExisting: false;
  };

  type ScheduleOption = ExistingCallOption | NewCallOption;

  // For scheduling mode, create options based on existing calls + missing slots
  const allScheduleOptions: ScheduleOption[] = (() => {
    if (!isPartialSchedulingMode && !isFullSchedulingMode) return [];

    const options: ScheduleOption[] = [];

    if (isPartialSchedulingMode) {
      // Add existing calls as reschedule options
      rescheduleOptions.forEach((opt, index) => {
        options.push({
          id: opt.id,
          label: `Reschedule Call ${index + 1}`,
          isExisting: true,
          start: opt.start,
          end: opt.end,
        });
      });

      // Add missing calls as schedule options
      for (let i = rescheduleOptions.length + 1; i <= totalExpectedCalls; i++) {
        options.push({
          id: `schedule_call_${i}`,
          label: `Schedule Call ${i}`,
          isExisting: false,
        });
      }
    } else {
      // Full scheduling mode - no existing calls
      for (let i = 1; i <= totalExpectedCalls; i++) {
        options.push({
          id: `schedule_call_${i}`,
          label: `Schedule Call ${i}`,
          isExisting: false,
        });
      }
    }

    return options;
  })();

  const confirmDisabled =
    isAllocating ||
    hasInProgressCall ||
    ((eventType === "subscription" || eventType === "class") &&
      (hasExistingCalls || isPartialSchedulingMode || isFullSchedulingMode) &&
      !selectedRescheduleId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-auto">
        <DialogHeader>
          <DialogTitle>Confirm Allocation</DialogTitle>
          <DialogDescription>
            Please review the details before confirming allocation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {infoRows
              .filter(([, value]) => value !== undefined && value !== "")
              .map(([label, value]) => (
                <div key={label} className="text-sm">
                  <span className="text-muted-foreground">{label}: </span>
                  <span className="font-medium">{String(value)}</span>
                </div>
              ))}
          </div>

          {selectedSlots?.length ? (
            <div className="max-h-64 overflow-auto rounded-md border p-3 space-y-3">
              <div className="text-sm font-semibold">
                {eventType === "subscription"
                  ? `Completed calls (${completedCalls.length})`
                  : eventType === "class"
                    ? `Completed sessions (${completedCalls.length})`
                    : `Selected session`}
              </div>

              {hasInProgressCall && (
                <div className="text-sm text-red-600">
                  {eventType === "class"
                    ? "A class session is in progress. Complete the ongoing session or clear selection."
                    : "A call is in progress. Complete the ongoing call or clear selection."}
                </div>
              )}

              {(eventType === "subscription" || eventType === "class") &&
                completedCalls.length === 0 &&
                !hasInProgressCall && (
                  <div className="text-sm text-muted-foreground">
                    No completed calls in selection.
                  </div>
                )}

              <ol className="text-sm space-y-2 list-decimal list-inside">
                {eventType === "subscription" || eventType === "class"
                  ? completedCalls.map((c, idx) => (
                      <li key={`${c.start.toISOString()}-${idx}`}>
                        <div>
                          <span className="font-medium">
                            {eventType === "class" ? "Session" : "Call"}{" "}
                            {idx + 1}:
                          </span>{" "}
                          <span>
                            {format(c.start, "eee, MMM d yyyy HH:mm")} –{" "}
                            {format(c.end, "HH:mm")} (UTC)
                          </span>
                        </div>
                        <div className="text-muted-foreground">
                          Local: {formatLocal(c.start)} – {formatLocal(c.end)}
                        </div>
                      </li>
                    ))
                  : // For single-session events, show one entry if any slots exist
                    selectedSlots.length > 0 && (
                      <li>
                        <div>
                          <span className="font-medium">Call 1:</span>{" "}
                          <span>
                            {format(
                              selectedSlots[0].startTime,
                              "eee, MMM d yyyy HH:mm",
                            )}{" "}
                            –{" "}
                            {format(
                              selectedSlots[selectedSlots.length - 1].endTime,
                              "HH:mm",
                            )}{" "}
                            (UTC)
                          </span>
                        </div>
                        <div className="text-muted-foreground">
                          Local: {formatLocal(selectedSlots[0].startTime)} –{" "}
                          {formatLocal(
                            selectedSlots[selectedSlots.length - 1].endTime,
                          )}
                        </div>
                      </li>
                    )}
              </ol>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No slots selected.
            </div>
          )}

          {/* Reschedule or Schedule options for subscriptions and classes */}
          {(eventType === "subscription" || eventType === "class") &&
            (hasExistingCalls ||
              isPartialSchedulingMode ||
              isFullSchedulingMode) && (
              <div className="text-sm">
                {isFullSchedulingMode ? (
                  // Full scheduling mode - no existing calls
                  <>
                    <div className="mb-2 text-muted-foreground">
                      No previous slots found.
                    </div>
                    <div className="mb-1">Select which call to schedule:</div>
                  </>
                ) : isPartialSchedulingMode ? (
                  // Partial scheduling mode - some existing calls
                  <>
                    <div className="mb-2 text-muted-foreground">
                      {rescheduleOptions.length} of {totalExpectedCalls} calls
                      scheduled.
                    </div>
                    <div className="mb-1">
                      Select a call to reschedule or schedule the remaining
                      call:
                    </div>
                  </>
                ) : (
                  // Regular reschedule mode - all calls exist
                  <div className="mb-1">Select a call to reschedule:</div>
                )}

                <RadioGroup
                  value={selectedRescheduleId || ""}
                  onValueChange={(val) => onChangeSelectedRescheduleId?.(val)}
                  className="gap-2"
                >
                  {(isPartialSchedulingMode || isFullSchedulingMode
                    ? allScheduleOptions
                    : rescheduleOptions
                  ).map((opt) => {
                    const isScheduleOption = "isExisting" in opt;

                    return (
                      <div key={opt.id} className="flex items-center gap-2">
                        <RadioGroupItem id={`opt-${opt.id}`} value={opt.id} />
                        <Label
                          htmlFor={`opt-${opt.id}`}
                          className="cursor-pointer"
                        >
                          {isScheduleOption ? (
                            // For scheduling modes, show custom labels
                            opt.isExisting && "start" in opt && "end" in opt ? (
                              <>
                                {opt.label}:{" "}
                                {format(opt.start, "eee, dd MMM HH:mm")}–
                                {format(opt.end, "HH:mm")}
                              </>
                            ) : (
                              opt.label
                            )
                          ) : (
                            // For regular reschedule mode, show time format
                            `${format(opt.start, "eee, dd MMM HH:mm")}–${format(opt.end, "HH:mm")}`
                          )}
                        </Label>
                      </div>
                    );
                  })}
                </RadioGroup>
              </div>
            )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isAllocating}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={confirmDisabled}>
            {isAllocating ? "Allocating..." : "Confirm Allocation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AllocationConfirmationDialog;
