"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Video, Loader2, ChevronDown } from "lucide-react";
import { cn } from "@/utils/tailwind";
import {
  DEFAULT_MEETING_DURATION_MS,
  type SlotWithMeetingSession,
  type SessionStatus,
} from "../types";

interface SessionTimelineProps {
  slots: SlotWithMeetingSession[];
  isJoining: boolean;
  onJoinSlot: (slot: SlotWithMeetingSession) => void;
}

/** A group of slots belonging to the same appointment (= one session). */
interface SessionGroup {
  appointmentId: string;
  slots: SlotWithMeetingSession[];
  startTime: Date;
  endTime: Date;
}

function getSlotStatus(slot: SlotWithMeetingSession): SessionStatus {
  const now = Date.now();
  const start = new Date(slot.startsAt).getTime();
  const end = slot.endsAt
    ? new Date(slot.endsAt).getTime()
    : start + DEFAULT_MEETING_DURATION_MS;
  const joinWindow = start - 10 * 60 * 1000;

  if (now >= joinWindow && now <= end && !slot.isTentative) return "joinable";
  if (now > end && slot.meetingSession?.endedAt) return "completed";
  if (now > end) return "noRecord";
  return "upcoming";
}

/** Derive session-level status from constituent slot statuses. */
function getSessionStatus(session: SessionGroup): SessionStatus {
  const slotStatuses = session.slots.map(getSlotStatus);
  if (slotStatuses.some((s) => s === "joinable")) return "joinable";
  if (slotStatuses.every((s) => s === "completed")) return "completed";
  if (
    slotStatuses.every((s) => s === "completed" || s === "noRecord")
  )
    return "noRecord";
  return "upcoming";
}

/** Find the first joinable slot within a session (for the join action). */
function getJoinableSlot(
  session: SessionGroup,
): SlotWithMeetingSession | undefined {
  return session.slots.find((s) => getSlotStatus(s) === "joinable");
}

/** Group a flat array of slots by appointmentId into sessions. */
function groupSlotsBySession(
  slots: SlotWithMeetingSession[],
): SessionGroup[] {
  const groups = new Map<string, SlotWithMeetingSession[]>();
  for (const slot of slots) {
    const key = slot.appointmentId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(slot);
  }
  return Array.from(groups.entries())
    .map(([appointmentId, sessionSlots]) => {
      const sorted = sessionSlots.sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      );
      return {
        appointmentId,
        slots: sorted,
        startTime: new Date(sorted[0].startsAt),
        endTime: new Date(sorted[sorted.length - 1].endsAt),
      };
    })
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

const statusIcon: Record<SessionStatus, string> = {
  completed: "\u2705",
  noRecord: "\u26A0\uFE0F",
  joinable: "\u25C9",
  upcoming: "\u25CB",
};

const statusLabel: Record<SessionStatus, string> = {
  completed: "COMPLETED",
  noRecord: "NO RECORD",
  joinable: "JOIN",
  upcoming: "upcoming",
};

const COLLAPSED_LIMIT = 5;

export function SessionTimeline({
  slots,
  isJoining,
  onJoinSlot,
}: SessionTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  const nonTentativeSlots = slots.filter((s) => !s.isTentative);
  const sessions = groupSlotsBySession(nonTentativeSlots);
  const showExpand = sessions.length > COLLAPSED_LIMIT;

  // When collapsed and > COLLAPSED_LIMIT: show dot summary + next upcoming/joinable sessions
  const visibleSessions =
    showExpand && !expanded
      ? (() => {
          // Find first upcoming/joinable index
          const firstUpcomingIdx = sessions.findIndex((session) => {
            const status = getSessionStatus(session);
            return status === "upcoming" || status === "joinable";
          });

          if (firstUpcomingIdx === -1) {
            // All past — show last 3
            return sessions.slice(-3);
          }

          // Show the joinable/upcoming and 2 surrounding
          const startIdx = Math.max(0, firstUpcomingIdx - 1);
          return sessions.slice(startIdx, startIdx + 3);
        })()
      : sessions;

  // Dot summary for collapsed view (one dot per session)
  const dotSummary =
    showExpand && !expanded
      ? sessions.map((session) => {
          const st = getSessionStatus(session);
          if (st === "completed") return "\u2705";
          if (st === "noRecord") return "\u26A0\uFE0F";
          if (st === "joinable") return "\u25C9";
          return "\u25CB";
        })
      : null;

  return (
    <div className="space-y-1">
      {/* Dot summary when collapsed */}
      {dotSummary && dotSummary.length > 0 && (
        <div className="flex items-center gap-0.5 px-1 py-1 text-xs">
          <span className="text-zinc-400 mr-1">Sessions:</span>
          {dotSummary.map((dot, i) => (
            <span key={i} className="text-[10px]">
              {dot}
            </span>
          ))}
        </div>
      )}

      {/* Session rows (one row per appointment group) */}
      {visibleSessions.map((session) => {
        const status = getSessionStatus(session);
        const isJoinable = status === "joinable";
        const joinableSlot = isJoinable ? getJoinableSlot(session) : undefined;

        return (
          <div
            key={session.appointmentId}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors",
              isJoinable
                ? "bg-green-50 border border-green-200 cursor-pointer hover:bg-green-100"
                : "bg-zinc-50",
              status === "completed" && "opacity-70",
              status === "noRecord" && "opacity-80",
            )}
            onClick={
              isJoinable && joinableSlot
                ? () => onJoinSlot(joinableSlot)
                : undefined
            }
            role={isJoinable ? "button" : undefined}
            tabIndex={isJoinable ? 0 : undefined}
            onKeyDown={
              isJoinable && joinableSlot
                ? (e) => e.key === "Enter" && onJoinSlot(joinableSlot)
                : undefined
            }
          >
            {/* Status icon */}
            <span
              className="text-sm shrink-0 w-5 text-center"
              aria-label={status}
            >
              {statusIcon[status]}
            </span>

            {/* Date + time range */}
            <div className="flex-1 min-w-0">
              <span className="font-medium text-zinc-700">
                {format(session.startTime, "MMM d")}
              </span>
              <span className="text-zinc-400 ml-2">
                {format(session.startTime, "h:mm a")}
                {" - "}
                {format(session.endTime, "h:mm a")}
              </span>
            </div>

            {/* Action / status label */}
            {isJoinable && joinableSlot ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onJoinSlot(joinableSlot);
                }}
                disabled={isJoining}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-green-600 text-white text-[10px] font-semibold hover:bg-green-700 disabled:opacity-50"
              >
                {isJoining ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Video className="h-3 w-3" />
                )}
                JOIN
              </button>
            ) : (
              <span
                className={cn(
                  "text-[10px] font-medium uppercase",
                  status === "completed" && "text-zinc-400",
                  status === "noRecord" && "text-amber-500",
                  status === "upcoming" && "text-zinc-400",
                )}
                title={
                  status === "noRecord"
                    ? "No meeting record found for this session. It may have been missed or held outside the platform."
                    : undefined
                }
              >
                {statusLabel[status]}
              </span>
            )}
          </div>
        );
      })}

      {/* Show all / collapse */}
      {showExpand && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 w-full justify-center py-1 text-xs text-zinc-500 hover:text-zinc-700"
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              expanded && "rotate-180",
            )}
          />
          {expanded
            ? "Show less"
            : `Show all ${sessions.length} sessions`}
        </button>
      )}
    </div>
  );
}
