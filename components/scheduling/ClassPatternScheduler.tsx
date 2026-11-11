"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useNowTick } from "@/hooks/use-now-tick";
import { createSubmissionKeys } from "@/lib/api/submission-key";
import { OUTCOME_UNKNOWN_MESSAGE } from "@/lib/fetch-helpers";
import {
  PATTERN_PROBLEM_COPY,
  patternProblem,
  projectPattern,
  sessionAtoms,
  startDatePhase,
  type PatternRow,
} from "@/lib/booking/class-pattern";
import { eventLeadMs } from "@/lib/booking/event-time-rules";
import {
  atomIndex,
  singleSessionOptions,
  SINGLE_SESSION_STATE_LABEL,
} from "@/lib/scheduling/single-session-options";
import { useAvailabilityWindow } from "@/lib/scheduling/use-availability-window";
import { formatDateTimeLabel } from "@/lib/time/display";
import { MAX_CLASS_SESSIONS_PER_DAY } from "@/utils/scheduling-engine/sessionCaps";
import { formatInTimeZone } from "date-fns-tz";
import { cn } from "@/utils/tailwind";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PREVIEW_DAYS = 28;

function timeLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The 48 local starts of a day that land on the UTC atoms, `phase` minutes past :00/:30. */
function dayTimes(phase: number): number[] {
  return Array.from({ length: 48 }, (_, i) => phase + i * 30);
}

/** Sessions a week spread across the week at 18:00 (18:15 at +05:45): 3 → Mon, Wed, Fri. */
export function defaultRows(
  sessionsPerWeek: number,
  phase: number,
): PatternRow[] {
  const count = Math.min(7, Math.max(1, sessionsPerWeek));
  const gap = Math.max(1, Math.floor(7 / count));
  return Array.from({ length: count }, (_, i) => ({
    weekday: (1 + i * gap) % 7,
    startMinutes: 18 * 60 + phase,
  }));
}

export interface ClassPatternSchedulerProps {
  classId: string;
  consultantId: string;
  /** The host's zone: the pattern is wall-clock time there. */
  zone: string;
  sessionMinutes: number;
  totalSessions: number;
  sessionsPerWeek: number;
  /** The class already has sessions (re-planning an unsold class). */
  hasSessions: boolean;
  /**
   * "schedule" places an unsold class through the allocator; "retime" moves a
   * sold class's sessions that are 24 hours or more away through the series
   * re-time (`appointmentId` required), with its free-leave refund.
   */
  mode?: "schedule" | "retime";
  appointmentId?: string;
  onSaved: () => void;
  onUseCalendar?: () => void;
}

/**
 * Schedule a whole class from a weekly pattern: a start date plus weekday and
 * time rows, previewed as the N sessions it produces with each one labelled
 * against the host's calendar. Saving sends exactly those times to the
 * allocator, which re-checks every one (overlap, co-hosts, the per-day cap).
 * Works the same on a phone; the week grid stays available as a calendar view.
 */
export function ClassPatternScheduler({
  classId,
  consultantId,
  zone,
  sessionMinutes,
  totalSessions,
  sessionsPerWeek,
  hasSessions,
  mode = "schedule",
  appointmentId,
  onSaved,
  onUseCalendar,
}: Readonly<ClassPatternSchedulerProps>) {
  const { toast } = useToast();
  const now = useNowTick(60_000);
  const notBeforeMs =
    now.getTime() + eventLeadMs(mode === "retime" ? "retime" : "makeup");
  const [startDate, setStartDate] = useState(() =>
    formatInTimeZone(new Date(notBeforeMs), zone, "yyyy-MM-dd"),
  );
  const phase = startDatePhase(startDate, zone);
  const times = useMemo(() => dayTimes(phase), [phase]);
  const [rows, setRows] = useState<PatternRow[]>(() =>
    defaultRows(sessionsPerWeek, phase),
  );
  const [saving, setSaving] = useState(false);
  const [confirmOutside, setConfirmOutside] = useState(false);
  const [keyFor] = useState(createSubmissionKeys);

  const pattern = { startDate, rows, zone };
  const problem = patternProblem(pattern, MAX_CLASS_SESSIONS_PER_DAY);
  const starts = useMemo(
    () =>
      problem
        ? []
        : projectPattern({ startDate, rows, zone }, totalSessions, notBeforeMs),
    [problem, startDate, rows, zone, totalSessions, notBeforeMs],
  );

  const previewStart = starts[0] ?? new Date(notBeforeMs);
  const previewEnd = new Date(
    previewStart.getTime() + PREVIEW_DAYS * 86_400_000,
  );
  const availability = useAvailabilityWindow({
    consultantId,
    startUtc: previewStart,
    endUtc: previewEnd,
    timezone: zone,
    event: { classId, moving: mode === "retime" },
    keepPrevious: true,
    enabled: starts.length > 0,
  });
  const atoms = useMemo(
    () => atomIndex(availability.data),
    [availability.data],
  );
  const labelled = starts.map((start) => {
    if (start.getTime() >= previewEnd.getTime()) {
      return {
        start,
        label: "Checked when you save",
        blocking: false,
        outside: false,
      };
    }
    const [option] = singleSessionOptions({
      atoms,
      dayStartMs: start.getTime(),
      dayEndMs: start.getTime() + 1,
      sessionMinutes,
      notBeforeMs,
    });
    if (!option) {
      return {
        start,
        label: "Checked when you save",
        blocking: false,
        outside: false,
      };
    }
    return {
      start,
      label: SINGLE_SESSION_STATE_LABEL[option.state],
      blocking: !option.selectable,
      outside: option.state === "outsideHours",
    };
  });
  const busyCount = labelled.filter((row) => row.blocking).length;
  const outsideCount = labelled.filter((row) => row.outside).length;
  const short = !problem && starts.length < totalSessions;

  const save = async () => {
    setSaving(true);
    // The same times re-sent reuse their key, so a retry replays the first answer.
    const idempotencyKey = keyFor({ mode, starts });
    try {
      const response =
        mode === "retime" && appointmentId
          ? await fetch(`/api/appointments/${appointmentId}/retime-series`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                starts: starts.map((start) => start.toISOString()),
              }),
            })
          : await fetch(`/api/bookings/classes/${classId}/allocate`, {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify({
                isAuto: false,
                slots: sessionAtoms(starts, sessionMinutes),
                // A host may run a class outside their published hours.
                override: true,
                ...(hasSessions ? {} : { initialAllocation: true }),
              }),
            });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        toast({
          title: "Couldn't save the schedule",
          description:
            body.error ?? body.message ?? "Check the times and try again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title:
          mode === "retime"
            ? `${starts.length} sessions moved — learners have been told`
            : `${starts.length} sessions scheduled`,
      });
      onSaved();
    } catch {
      // The request never got an answer, so the outcome is unknown.
      toast({
        title: "Couldn't reach the server",
        description: OUTCOME_UNKNOWN_MESSAGE,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor="class-start-date">First possible day</Label>
          <Input
            id="class-start-date"
            type="date"
            value={startDate}
            min={formatInTimeZone(new Date(notBeforeMs), zone, "yyyy-MM-dd")}
            onChange={(event) => setStartDate(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">Times are in {zone}.</p>
        </div>
        <div className="space-y-2">
          <Label>Meets every week on</Label>
          {rows.map((row, index) => (
            <div key={`${index}`} className="flex items-center gap-2">
              <select
                aria-label={`Day ${index + 1}`}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={row.weekday}
                onChange={(event) =>
                  setRows((all) =>
                    all.map((r, i) =>
                      i === index
                        ? { ...r, weekday: Number(event.target.value) }
                        : r,
                    ),
                  )
                }
              >
                {WEEKDAYS.map((day, value) => (
                  <option key={day} value={value}>
                    {day}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Time ${index + 1}`}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={row.startMinutes}
                onChange={(event) =>
                  setRows((all) =>
                    all.map((r, i) =>
                      i === index
                        ? { ...r, startMinutes: Number(event.target.value) }
                        : r,
                    ),
                  )
                }
              >
                {times.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {timeLabel(minutes)}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove day ${index + 1}`}
                disabled={rows.length === 1}
                onClick={() =>
                  setRows((all) => all.filter((_, i) => i !== index))
                }
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setRows((all) => [
                ...all,
                { weekday: 1, startMinutes: 18 * 60 + phase },
              ])
            }
          >
            <Plus className="mr-1 h-4 w-4" /> Add a day
          </Button>
          {rows.length !== sessionsPerWeek && (
            <p className="text-xs text-muted-foreground">
              The plan says {sessionsPerWeek} a week; this pattern meets{" "}
              {rows.length} times a week, so the class runs{" "}
              {rows.length > sessionsPerWeek ? "faster" : "longer"}.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-md border">
        <div className="flex items-center justify-between border-b px-3 py-2 text-sm">
          <span className="font-medium">
            {problem
              ? PATTERN_PROBLEM_COPY[problem]
              : `${starts.length} of ${totalSessions} sessions`}
          </span>
          {busyCount > 0 && (
            <span className="text-xs text-destructive">
              {busyCount} clash with your calendar — change those days or times
            </span>
          )}
        </div>
        <ol className="max-h-72 divide-y overflow-y-auto text-sm">
          {labelled.map(({ start, label, blocking }, index) => (
            <li
              key={start.toISOString()}
              className={cn(
                "flex items-center justify-between px-3 py-1.5",
                blocking && "bg-destructive/5",
              )}
            >
              <span>
                <span className="mr-2 tabular-nums text-muted-foreground">
                  {index + 1}.
                </span>
                {formatDateTimeLabel(start, { zone })}
              </span>
              <span
                className={cn(
                  "text-xs",
                  blocking ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>
        {short && (
          <p className="border-t px-3 py-2 text-xs text-destructive">
            This pattern can&apos;t place all {totalSessions} sessions. Pick an
            earlier start or more days.
          </p>
        )}
      </div>

      <div className="sticky bottom-0 z-10 flex flex-col gap-2 border-t bg-background py-2">
        {outsideCount > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {outsideCount} of {starts.length} sessions are outside your
            published hours. You can still schedule them.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onUseCalendar && (
            <Button type="button" variant="ghost" onClick={onUseCalendar}>
              Use the calendar view instead
            </Button>
          )}
          <Button
            type="button"
            onClick={() =>
              outsideCount > 0 ? setConfirmOutside(true) : void save()
            }
            disabled={saving || Boolean(problem) || short || busyCount > 0}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
              </>
            ) : mode === "retime" ? (
              `Move ${starts.length} sessions`
            ) : (
              `Schedule ${starts.length} sessions`
            )}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOutside}
        onOpenChange={setConfirmOutside}
        title="Schedule outside your published hours?"
        description={`${outsideCount} of ${starts.length} sessions fall outside the hours you publish. Learners see the times you pick.`}
        confirmLabel={
          mode === "retime"
            ? `Move ${starts.length} sessions`
            : `Schedule ${starts.length} sessions`
        }
        onConfirm={save}
      />
    </div>
  );
}
