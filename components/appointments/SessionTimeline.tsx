"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Video, Loader2, ChevronDown } from "lucide-react";
import { cn } from "@/utils/tailwind";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  DEFAULT_MEETING_DURATION_MS,
  getSessionVMJoinState,
  isSessionOver,
} from "@/lib/appointments/slots";
import type { SessionVM } from "@/lib/appointments/view-model";
import { CountdownBadge } from "./CountdownBadge";

/**
 * Per-session timeline for multi-session (and one-off) appointments.
 * Generalized from the consultee card timeline to consume SessionVM[].
 *
 * One SessionVM is one row. It used to re-group by owning appointment,
 * because the mappers emitted a VM per 30-minute slot row — but that rule was
 * wrong in the other direction: two separate sittings booked under a single
 * appointment fused into one row spanning both. The mappers now group into
 * contiguous runs (#1061, `sessionsOfAppointment`), which is the same rule the
 * room key and the join gate use, so re-grouping here would only undo it.
 */

type SessionStatus = "completed" | "noRecord" | "upcoming" | "joinable";

interface SessionTimelineProps {
  sessions: SessionVM[];
  isJoining?: boolean;
  /** Absent ⇒ read-only timeline (no JOIN buttons). */
  onJoinSession?: (session: SessionVM) => void;
  joinWindowMs?: number;
  /** Rows rendered when collapsed (default 1 focus row). */
  className?: string;
  /**
   * When false, collapse to a single focus row with an expander.
   * Defaults to true so multi-session plans show the full list.
   */
  defaultExpanded?: boolean;
}

interface SessionGroup {
  key: string;
  slots: SessionVM[];
  startTime: Date;
  endTime: Date;
}

/**
 * #1270 — the joinable branch used to be a bare clock comparison against
 * `startsAt`/`endsAt`, which never consulted `meetingEndedAt`. A call the host
 * had already closed therefore kept offering JOIN for the rest of the booked
 * hour, dropping whoever clicked it into a fresh empty room. Routing through
 * the shared predicate makes an ended run non-joinable here too.
 */
function slotStatus(slot: SessionVM, joinWindowMs: number): SessionStatus {
  const state = getSessionVMJoinState(slot, { joinWindowMs });
  if (state === "joinable") return "joinable";
  if (state === "countdown") return "upcoming";
  // The host closing the call early is what separates a session we have a
  // record of from one that simply ran past its slot with nobody in it.
  if (slot.meetingEndedAt) return "completed";
  // `disabled` on a session whose time has not arrived is a dead row
  // (cancelled, or released for reschedule) — "no record" would be a lie
  // about the future, so it keeps reading as upcoming.
  return isSessionOver(slot) ? "noRecord" : "upcoming";
}

function sessionStatusOf(
  group: SessionGroup,
  joinWindowMs: number,
): SessionStatus {
  const statuses = group.slots.map((s) => slotStatus(s, joinWindowMs));
  if (statuses.some((s) => s === "joinable")) return "joinable";
  if (statuses.every((s) => s === "completed")) return "completed";
  if (statuses.every((s) => s === "completed" || s === "noRecord")) {
    return "noRecord";
  }
  return "upcoming";
}

function toSessionGroups(sessions: SessionVM[]): SessionGroup[] {
  return [...sessions]
    .map((session) => ({
      // The anchor's slot id — unique per run, and the same id the video room
      // is keyed to, so a row and its meeting name each other.
      key: session.slotId,
      slots: [session],
      startTime: session.startsAt,
      endTime:
        session.endsAt ??
        new Date(session.startsAt.getTime() + DEFAULT_MEETING_DURATION_MS),
    }))
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

const statusIcon: Record<SessionStatus, string> = {
  completed: "✅",
  noRecord: "⚠️",
  joinable: "◉",
  upcoming: "○",
};

/**
 * The `joinable` entry is reachable ONLY when the row is inside its window and
 * the caller supplied no join handler — a joinable row that can be joined
 * renders the button instead. It used to read "JOIN" in unmuted text, so a row
 * the adapter had deliberately refused looked like a live button and did
 * nothing when clicked (#1270). It now names a state, not an action.
 */
const statusLabel: Record<SessionStatus, string> = {
  completed: "COMPLETED",
  noRecord: "NO RECORD",
  joinable: "IN PROGRESS",
  upcoming: "upcoming",
};

export function SessionTimeline({
  sessions,
  isJoining = false,
  onJoinSession,
  joinWindowMs = CONSULTEE_JOIN_WINDOW_MS,
  className,
  defaultExpanded = true,
}: SessionTimelineProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  const nonTentative = useMemo(
    () => sessions.filter((s) => !s.isTentative),
    [sessions],
  );
  const groups = useMemo(() => toSessionGroups(nonTentative), [nonTentative]);
  const showExpand = groups.length > 1;

  const groupStatuses = useMemo(
    () =>
      new Map(
        groups.map((g) => [g.key, sessionStatusOf(g, joinWindowMs)] as const),
      ),
    [groups, joinWindowMs],
  );

  // First strictly-upcoming session gets the relative countdown badge;
  // joinable rows already carry the JOIN button.
  const nextUpcomingKey = useMemo(() => {
    for (const g of groups) {
      if (groupStatuses.get(g.key) === "upcoming") return g.key;
    }
    return null;
  }, [groups, groupStatuses]);

  // Collapsed = ONE focus row: live/joinable, else next upcoming, else the
  // most recent past session — full timeline behind the expander.
  const focusGroup = useMemo(() => {
    let upcoming: SessionGroup | undefined;
    for (const g of groups) {
      const status = groupStatuses.get(g.key);
      if (status === "joinable") return g;
      if (status === "upcoming" && !upcoming) upcoming = g;
    }
    return upcoming ?? groups[groups.length - 1];
  }, [groups, groupStatuses]);

  if (groups.length === 0) return null;

  const visibleGroups =
    showExpand && !expanded && focusGroup ? [focusGroup] : groups;

  const focusStatus = focusGroup
    ? groupStatuses.get(focusGroup.key)
    : undefined;
  const collapsedCaption =
    focusStatus === "joinable"
      ? "Live now"
      : focusStatus === "upcoming"
        ? "Next session"
        : "Last session";

  return (
    <div className={cn("space-y-1", className)}>
      {showExpand && !expanded && (
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {collapsedCaption}
        </p>
      )}

      {visibleGroups.map((group) => {
        const status = groupStatuses.get(group.key)!;
        const joinable =
          status === "joinable" && onJoinSession
            ? group.slots.find(
                (s) => slotStatus(s, joinWindowMs) === "joinable",
              )
            : undefined;

        return (
          <div
            key={group.key}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors",
              joinable
                ? "bg-green-50 border border-green-200 cursor-pointer hover:bg-green-100 dark:bg-green-900/20 dark:border-green-900/40 dark:hover:bg-green-900/30"
                : "bg-muted",
              status === "completed" && "opacity-70",
              status === "noRecord" && "opacity-80",
            )}
            onClick={joinable ? () => onJoinSession?.(joinable) : undefined}
            role={joinable ? "button" : undefined}
            tabIndex={joinable ? 0 : undefined}
            onKeyDown={
              joinable
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onJoinSession?.(joinable);
                    }
                  }
                : undefined
            }
          >
            <span
              className="text-sm shrink-0 w-5 text-center"
              aria-label={status}
            >
              {statusIcon[status]}
            </span>

            <div className="flex-1 min-w-0">
              <span className="font-medium text-foreground">
                {format(group.startTime, "MMM d")}
              </span>
              <span className="text-muted-foreground/70 ml-2">
                {format(group.startTime, "h:mm a")}
                {" - "}
                {format(group.endTime, "h:mm a")}
              </span>
            </div>

            {joinable ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onJoinSession?.(joinable);
                }}
                disabled={isJoining}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-green-600 text-white text-[10px] font-semibold hover:bg-green-700 disabled:opacity-50 dark:bg-green-600 dark:hover:bg-green-500"
              >
                {isJoining ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Video className="h-3 w-3" />
                )}
                JOIN
              </button>
            ) : group.key === nextUpcomingKey && status === "upcoming" ? (
              <CountdownBadge
                targetDate={group.startTime}
                sessionEndDate={group.endTime}
              />
            ) : (
              <span
                className={cn(
                  "text-[10px] font-medium uppercase text-muted-foreground/70",
                  status === "noRecord" && "text-amber-500 dark:text-amber-400",
                )}
                title={
                  status === "noRecord"
                    ? "No meeting record found for this session. It may have been missed or held outside the platform."
                    : status === "joinable"
                      ? "This session's time has arrived, but it cannot be joined from here."
                      : undefined
                }
              >
                {statusLabel[status]}
              </span>
            )}
          </div>
        );
      })}

      {showExpand && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 w-full justify-center py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              expanded && "rotate-180",
            )}
          />
          {expanded
            ? "Show less"
            : `Show all ${groups.length} ${groups.length === 1 ? "session" : "sessions"}`}
        </button>
      )}
    </div>
  );
}
