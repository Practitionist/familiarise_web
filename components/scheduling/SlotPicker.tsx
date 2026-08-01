"use client";

import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DesktopOnlyNotice } from "@/components/scheduling/DesktopOnlyNotice";
import { SafeUnifiedCalendar } from "@/components/scheduling/SafeUnifiedCalendar";
import {
  groupReleasableSessions,
  SessionReleasePicker,
  type ReleaseMode,
} from "@/components/scheduling/SessionReleasePicker";
import type {
  SlotPickerPolicy,
  SlotPickerSubject,
} from "@/components/scheduling/slot-picker-policy";
import { resolveFocusTarget } from "@/lib/scheduling/slot-picker-focus";
import { cn } from "@/utils/tailwind";

/**
 * The one surface for choosing times, shared by allocation, both reschedule
 * roles and a consultant's own event timings.
 *
 * It takes a policy object rather than a prop per difference. The four callers
 * disagree about lead time, whether anything is being released and who owns
 * the submit; all of that is data in `slot-picker-policy.ts`, so nothing here
 * branches on which caller it is.
 */

export interface SlotPickerProps {
  policy: SlotPickerPolicy;
  subject: SlotPickerSubject;
  /** A submit is in flight; the policy's owner knows, this component does not. */
  isSubmitting?: boolean;
  /** Back out. Also wired to the allocate grid's own Cancel button. */
  onCancel?: () => void;
  className?: string;
}

export function SlotPicker({
  policy,
  subject,
  isSubmitting = false,
  onCancel,
  className,
}: Readonly<SlotPickerProps>) {
  const sessions = React.useMemo(
    () => groupReleasableSessions(subject.slots ?? []),
    [subject.slots],
  );

  // "First open" is this mount, and the target is pinned to it. Re-resolving
  // against a moving `now` would let the grid drift under a consultant who
  // left the tab open (#1073).
  const [openedAt] = React.useState(() => new Date());
  const focus = React.useMemo(
    () => resolveFocusTarget(subject, openedAt),
    [subject, openedAt],
  );

  const [releaseMode, setReleaseMode] = React.useState<ReleaseMode>("entire");
  const [selectedSlotIds, setSelectedSlotIds] = React.useState<string[]>([]);
  const [proposedSlots, setProposedSlots] = React.useState<
    { startsAt: string; endsAt: string }[]
  >([]);

  /** A one-session booking has nothing to choose between. */
  const showReleaseStep = policy.showReleasedSlots && sessions.length > 1;
  const picksSpecificSessions = showReleaseStep && releaseMode !== "entire";

  /** A picking mode is active but nothing is ticked — there is no request yet. */
  const selectionIncomplete =
    picksSpecificSessions && selectedSlotIds.length === 0;

  const releasedSlotIds = picksSpecificSessions
    ? selectedSlotIds
    : /* Every session; the API reads an absent list as "all of them". */
      undefined;

  const selectedSessionCount = React.useMemo(
    () =>
      sessions.filter((session) =>
        session.slots.every((slot) => selectedSlotIds.includes(slot.id)),
      ).length,
    [sessions, selectedSlotIds],
  );

  /** How many times to ask for, so the hint matches what is actually moving. */
  const sessionsBeingMoved = picksSpecificSessions
    ? Math.max(selectedSessionCount, 1)
    : Math.max(sessions.length, 1);

  const submit = (withTimes: boolean) => {
    void policy.onSubmit({
      slotIds: releasedSlotIds,
      proposedSlots:
        withTimes && proposedSlots.length > 0 ? proposedSlots : undefined,
    });
  };

  const isSelectMode = policy.calendarMode === "select";

  return (
    <DesktopOnlyNotice className={cn("min-h-0 gap-4", className)}>
      {policy.minLeadHours > 0 && (
        <div className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-900/20">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            <strong>Note:</strong> sessions cannot be moved within{" "}
            {policy.minLeadHours} hours of their start time, and rescheduling
            is not refunded.
          </p>
        </div>
      )}

      {showReleaseStep && (
        <div className="shrink-0">
          <SessionReleasePicker
            sessions={sessions}
            minLeadHours={policy.minLeadHours}
            mode={releaseMode}
            onModeChange={setReleaseMode}
            selectedSlotIds={selectedSlotIds}
            onSelectionChange={setSelectedSlotIds}
          />
        </div>
      )}

      <p className="shrink-0 text-sm text-muted-foreground">
        {isSelectMode && (
          <span className="font-medium text-foreground">
            {sessionsBeingMoved === 1
              ? "Pick a time. "
              : `Pick ${sessionsBeingMoved} times. `}
          </span>
        )}
        {policy.pickerHint}
      </p>

      <SafeUnifiedCalendar
        className="min-h-0 flex-1"
        consultantId={subject.consultantProfileId}
        eventType={subject.eventType}
        eventId={subject.eventId}
        consulteeUserId={subject.counterpartUserId}
        mode={policy.calendarMode}
        sessionDurationInHours={subject.sessionDurationInHours}
        durationInHours={subject.durationInHours}
        sessionsPerWeek={subject.sessionsPerWeek}
        durationInMonths={subject.durationInMonths}
        totalSessions={subject.totalSessions}
        schedulingTimezone={subject.schedulingTimezone}
        allowedStart={subject.allowedStart}
        allowedEnd={subject.allowedEnd}
        // Deliberately NOT keyed to the release selection: focus is a
        // starting position, and re-aiming the grid while someone is reading
        // it is worse than the empty night rows it replaces (#1073).
        focus={focus}
        // Fresh allocations only: a partial reschedule legitimately keeps
        // confirmed slots and must not trip the guard.
        initialAllocation={
          policy.appliesInitialAllocationGuard
            ? !subject.hasReleasedSlots
            : undefined
        }
        showAllocationButtons={!isSelectMode}
        onSlotsSelected={(slots) =>
          setProposedSlots(
            slots.map((slot) => ({
              startsAt: slot.startTime.toISOString(),
              endsAt: slot.endTime.toISOString(),
            })),
          )
        }
        onAllocationComplete={() => void policy.onSubmit({})}
        onAllocationConflict={policy.onConflict}
        onClose={onCancel}
      />

      {/* Only "select" needs a footer — the allocate grid renders its own. */}
      {isSelectMode && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {proposedSlots.length > 0 && (
            <p className="mr-auto text-sm text-muted-foreground">
              {proposedSlots.length} slot
              {proposedSlots.length === 1 ? "" : "s"} selected.
            </p>
          )}

          {onCancel && (
            <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          )}

          {/* Naming a time is an OPTION, never a requirement. Releasing without
              one hands the counterparty a request to place, which is how every
              reschedule worked before proposals existed — so this stays on
              every reschedule surface and at every session count. */}
          {policy.allowReleaseWithoutTime && (
            <Button
              variant="outline"
              onClick={() => submit(false)}
              disabled={isSubmitting || selectionIncomplete}
            >
              Any time works
            </Button>
          )}

          <Button
            onClick={() => submit(true)}
            disabled={
              isSubmitting || selectionIncomplete || proposedSlots.length === 0
            }
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              policy.submitLabel
            )}
          </Button>
        </div>
      )}
    </DesktopOnlyNotice>
  );
}
