"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Clock,
  CalendarClock,
  CalendarRange,
  CheckSquare,
  Check,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/utils/tailwind";
import { toDate, type SlotLike } from "@/lib/appointments/view-model";
import { SafeUnifiedCalendar } from "@/components/scheduling/SafeUnifiedCalendar";

/**
 * Multi-session reschedule dialog (one / multiple / entire program with the
 * 24-hour lock), extracted verbatim from MultiSessionEventCard so the shared
 * appointments surface can mount it once, adapter-controlled.
 */

interface RescheduleSessionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Subscription" | "Class" — copy only. */
  typeLabel: string;
  /** Future/ongoing slots of the program (useEventActions rawSlots shape). */
  rawSlots: SlotLike[];
  isLoading: boolean;
  /**
   * The consultant delivering this program. When present the dialog offers a
   * second step where the consultee picks the times they actually want; without
   * it the dialog degrades to release-only, which is the old behaviour.
   */
  consultantProfileId?: string | null;
  /** Session length in hours, so the picker asks for the right block size. */
  sessionDurationInHours?: number;
  /**
   * Called with the selected slot ids (undefined = the entire program) and,
   * optionally, the times the consultee would like instead.
   */
  onConfirm: (args: {
    slotIds?: string[];
    proposedSlots?: { startsAt: string; endsAt: string }[];
  }) => void;
}

function formatSlotDate(date: Date | string): string {
  return format(toDate(date), "EEE, d MMM yyyy");
}

function formatSlotTime(date: Date | string): string {
  return format(toDate(date), "h:mm a");
}

type SessionWithProps = {
  slots: SlotLike[];
  isWithin24Hours: boolean;
  startTime: Date;
  endTime: Date;
};

/**
 * The which-sessions picker.
 *
 * Extracted because the modal now carries a second step, and holding both the
 * step machinery and this list in one function put it past the complexity
 * budget — the list is self-contained, so it moves rather than the step logic
 * being contorted around it.
 */
function SessionSelector({
  rescheduleType,
  sessions,
  selectedSlotIds,
  selectedSessionCount,
  onToggle,
}: Readonly<{
  rescheduleType: "individual" | "multiple";
  sessions: SessionWithProps[];
  selectedSlotIds: string[];
  selectedSessionCount: number;
  onToggle: React.Dispatch<React.SetStateAction<string[]>>;
}>) {
  return (
    <div className="mt-4 space-y-2">
      <Label className="text-sm font-medium text-foreground">
        {rescheduleType === "individual"
          ? "Select the session to reschedule:"
          : "Select sessions to reschedule:"}
      </Label>
      <div className="max-h-48 overflow-y-auto space-y-2 rounded-lg border border-border p-2">
        {sessions.map((session, sessionIndex) => {
          const sessionSlotIds = session.slots.map((s) => s.id);
          const isSelected = sessionSlotIds.every((id) =>
            selectedSlotIds.includes(id),
          );

          const handleSessionClick = () => {
            if (session.isWithin24Hours) return;
            if (rescheduleType === "individual") {
              onToggle(sessionSlotIds);
            } else if (isSelected) {
              onToggle((prev) =>
                prev.filter((id) => !sessionSlotIds.includes(id)),
              );
            } else {
              onToggle((prev) =>
                Array.from(new Set([...prev, ...sessionSlotIds])),
              );
            }
          };

          return (
            <button
              key={`session-${sessionIndex}`}
              type="button"
              onClick={handleSessionClick}
              disabled={session.isWithin24Hours}
              className={cn(
                "w-full flex items-center justify-between p-2.5 rounded-md text-left transition-colors",
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : session.isWithin24Hours
                    ? "bg-muted text-muted-foreground/70 cursor-not-allowed"
                    : "bg-muted hover:bg-muted/80 text-foreground",
              )}
            >
              <div className="flex items-center gap-2">
                {rescheduleType === "multiple" && (
                  <div
                    className={cn(
                      "w-4 h-4 rounded border flex items-center justify-center",
                      isSelected
                        ? "bg-primary-foreground border-primary-foreground"
                        : session.isWithin24Hours
                          ? "border-border"
                          : "border-muted-foreground",
                    )}
                  >
                    {isSelected && <Check className="h-3 w-3 text-primary" />}
                  </div>
                )}
                <div>
                  <div className="text-sm font-medium">
                    {formatSlotDate(session.startTime)}
                  </div>
                  <div
                    className={cn(
                      "text-xs",
                      isSelected
                        ? "text-primary-foreground/70"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatSlotTime(session.startTime)} -{" "}
                    {formatSlotTime(session.endTime)}
                  </div>
                </div>
              </div>
              {session.isWithin24Hours && (
                <span className="text-xs bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300 px-2 py-0.5 rounded">
                  Within 24h
                </span>
              )}
            </button>
          );
        })}
      </div>
      {rescheduleType === "multiple" && selectedSlotIds.length > 0 && (
        <p className="text-sm text-muted-foreground font-medium">
          {selectedSessionCount} session
          {selectedSessionCount > 1 ? "s" : ""} selected
        </p>
      )}
    </div>
  );
}

export function RescheduleSessionsModal({
  open,
  onOpenChange,
  typeLabel,
  rawSlots,
  isLoading,
  consultantProfileId,
  sessionDurationInHours,
  onConfirm,
}: Readonly<RescheduleSessionsModalProps>) {
  // Two steps: which sessions to move, then (optionally) when to move them to.
  const [step, setStep] = React.useState<"sessions" | "times">("sessions");
  const [proposedSlots, setProposedSlots] = React.useState<
    { startsAt: string; endsAt: string }[]
  >([]);
  const [rescheduleType, setRescheduleType] = React.useState<
    "individual" | "multiple" | "entire"
  >("entire");
  const [selectedSlotIds, setSelectedSlotIds] = React.useState<string[]>([]);

  // Reset selection whenever the dialog (re)opens for a program.
  React.useEffect(() => {
    if (open) {
      setRescheduleType("entire");
      setSelectedSlotIds([]);
      setStep("sessions");
      setProposedSlots([]);
    }
  }, [open]);

  // Group slots by appointmentId — one session can span multiple slots.
  const groupedSessions = React.useMemo(() => {
    const nonTentative = rawSlots.filter((slot) => !slot.isTentative);
    const groups = new Map<string, SlotLike[]>();
    for (const slot of nonTentative) {
      const key = slot.appointmentId ?? slot.id;
      const bucket = groups.get(key);
      if (bucket) bucket.push(slot);
      else groups.set(key, [slot]);
    }
    return Array.from(groups.values())
      .map((slots) => {
        const sorted = [...slots].sort(
          (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
        );
        const last = sorted[sorted.length - 1];
        return {
          slots: sorted,
          startTime: toDate(sorted[0].startsAt),
          endTime: toDate(last.endsAt ?? last.startsAt),
        };
      })
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  }, [rawSlots]);

  const sessionsWithDynamicProps = groupedSessions.map((session) => ({
    ...session,
    isWithin24Hours:
      (session.startTime.getTime() - Date.now()) / (1000 * 60 * 60) < 24,
  }));

  const selectedSessionCount = React.useMemo(() => {
    return groupedSessions.filter((session) =>
      session.slots.every((slot) => selectedSlotIds.includes(slot.id)),
    ).length;
  }, [groupedSessions, selectedSlotIds]);

  const releasedSlotIds =
    (rescheduleType === "individual" || rescheduleType === "multiple") &&
    selectedSlotIds.length > 0
      ? selectedSlotIds
      : undefined;

  /** How many sessions the consultee is moving, so the picker asks for that many. */
  const sessionsBeingMoved =
    releasedSlotIds === undefined
      ? groupedSessions.length
      : Math.max(selectedSessionCount, 1);

  const canProposeTimes = !!consultantProfileId;

  /**
   * Releasing without naming a time is still valid — it hands the consultant a
   * request with no stated preference, which is what every reschedule used to
   * do — so the secondary button says so rather than reading like a cancel.
   */
  const submitLabel = (() => {
    if (step === "times") return "Request this time";
    if (canProposeTimes) return "Any time works";
    return "Confirm Reschedule";
  })();

  const submit = (withTimes: boolean) => {
    onConfirm({
      slotIds: releasedSlotIds,
      proposedSlots:
        withTimes && proposedSlots.length ? proposedSlots : undefined,
    });
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scrollbar-hide">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" />
            Reschedule Options
          </ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Choose how you&apos;d like to reschedule your{" "}
            {typeLabel.toLowerCase()} sessions.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <div className="py-4 space-y-4">
          {step === "sessions" && (
            <>
              <RadioGroup
                value={rescheduleType}
                onValueChange={(value) => {
                  setRescheduleType(
                    value as "individual" | "multiple" | "entire",
                  );
                  if (value === "entire") {
                    setSelectedSlotIds([]);
                  } else if (value === "individual") {
                    // Auto-select the session containing the first selected slot
                    const firstSelectedId = selectedSlotIds[0];
                    const sessionWithFirst = groupedSessions.find((session) =>
                      session.slots.some((s) => s.id === firstSelectedId),
                    );
                    const first = sessionWithFirst
                      ? sessionWithFirst.slots.map((s) => s.id)
                      : groupedSessions.length > 0
                        ? groupedSessions[0].slots.map((s) => s.id)
                        : [];
                    setSelectedSlotIds(first);
                  }
                }}
                className="space-y-3"
              >
                <div
                  className={cn(
                    "flex items-start space-x-3 p-3 rounded-lg border transition-colors",
                    rescheduleType === "individual"
                      ? "border-primary bg-muted"
                      : "border-border hover:border-foreground/30",
                  )}
                >
                  <RadioGroupItem
                    value="individual"
                    id="individual"
                    className="mt-1"
                  />
                  <Label htmlFor="individual" className="flex-1 cursor-pointer">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      <CalendarClock className="h-4 w-4" />
                      Reschedule One Session
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Only the selected session will be rescheduled.
                    </p>
                  </Label>
                </div>

                <div
                  className={cn(
                    "flex items-start space-x-3 p-3 rounded-lg border transition-colors",
                    rescheduleType === "multiple"
                      ? "border-primary bg-muted"
                      : "border-border hover:border-foreground/30",
                  )}
                >
                  <RadioGroupItem
                    value="multiple"
                    id="multiple"
                    className="mt-1"
                  />
                  <Label htmlFor="multiple" className="flex-1 cursor-pointer">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      <CheckSquare className="h-4 w-4" />
                      Reschedule Multiple Sessions
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Select specific sessions to reschedule.
                    </p>
                  </Label>
                </div>

                <div
                  className={cn(
                    "flex items-start space-x-3 p-3 rounded-lg border transition-colors",
                    rescheduleType === "entire"
                      ? "border-primary bg-muted"
                      : "border-border hover:border-foreground/30",
                  )}
                >
                  <RadioGroupItem value="entire" id="entire" className="mt-1" />
                  <Label htmlFor="entire" className="flex-1 cursor-pointer">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      <CalendarRange className="h-4 w-4" />
                      Reschedule Entire {typeLabel}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      All {groupedSessions.length} sessions will be released.
                    </p>
                  </Label>
                </div>
              </RadioGroup>

              {(rescheduleType === "individual" ||
                rescheduleType === "multiple") && (
                <SessionSelector
                  rescheduleType={rescheduleType}
                  sessions={sessionsWithDynamicProps}
                  selectedSlotIds={selectedSlotIds}
                  selectedSessionCount={selectedSessionCount}
                  onToggle={setSelectedSlotIds}
                />
              )}

              <div className="bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-900/40 rounded-lg p-3">
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  <strong>Note:</strong> Sessions cannot be rescheduled within
                  24 hours of the start time. No refunds are provided for
                  rescheduling.
                </p>
              </div>
            </>
          )}

          {step === "times" && consultantProfileId && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Pick{" "}
                {sessionsBeingMoved === 1
                  ? "a time"
                  : `${sessionsBeingMoved} times`}{" "}
                that suit you. Green means the consultant is free — choosing one
                of those confirms straight away. Anything else is sent to them
                to approve.
              </p>

              <SafeUnifiedCalendar
                consultantId={consultantProfileId}
                eventType="consultation"
                mode="select"
                sessionDurationInHours={sessionDurationInHours}
                onSlotsSelected={(slots) =>
                  setProposedSlots(
                    slots.map((slot) => ({
                      startsAt: slot.startTime.toISOString(),
                      endsAt: slot.endTime.toISOString(),
                    })),
                  )
                }
              />

              {proposedSlots.length > 0 && (
                <p className="text-sm">
                  {proposedSlots.length} slot
                  {proposedSlots.length === 1 ? "" : "s"} selected.
                </p>
              )}
            </div>
          )}
        </div>

        <ResponsiveModalFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() =>
              step === "times" ? setStep("sessions") : onOpenChange(false)
            }
            disabled={isLoading}
          >
            {step === "times" ? "Back" : "Cancel"}
          </Button>

          {step === "sessions" && canProposeTimes && (
            <Button
              onClick={() => setStep("times")}
              disabled={
                isLoading ||
                ((rescheduleType === "individual" ||
                  rescheduleType === "multiple") &&
                  selectedSlotIds.length === 0)
              }
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Pick a new time
            </Button>
          )}

          <Button
            variant={step === "times" ? "default" : "outline"}
            onClick={() => submit(step === "times")}
            disabled={
              isLoading ||
              ((rescheduleType === "individual" ||
                rescheduleType === "multiple") &&
                selectedSlotIds.length === 0) ||
              (step === "times" && proposedSlots.length === 0)
            }
            className={
              step === "times"
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : undefined
            }
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
