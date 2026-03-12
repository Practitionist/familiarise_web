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

const statusIcon: Record<SessionStatus, string> = {
  completed: "✅",
  noRecord: "⚠️",
  joinable: "◉",
  upcoming: "○",
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
  const showExpand = nonTentativeSlots.length > COLLAPSED_LIMIT;

  // When collapsed and > COLLAPSED_LIMIT: show dot summary + next upcoming/joinable slots
  const visibleSlots =
    showExpand && !expanded
      ? (() => {
          // Find first upcoming/joinable index
          const firstUpcomingIdx = nonTentativeSlots.findIndex((s) => {
            const status = getSlotStatus(s);
            return status === "upcoming" || status === "joinable";
          });

          if (firstUpcomingIdx === -1) {
            // All past — show last 3
            return nonTentativeSlots.slice(-3);
          }

          // Show the joinable/upcoming and 2 surrounding
          const startIdx = Math.max(0, firstUpcomingIdx - 1);
          return nonTentativeSlots.slice(startIdx, startIdx + 3);
        })()
      : nonTentativeSlots;

  // Dot summary for collapsed view
  const dotSummary =
    showExpand && !expanded
      ? nonTentativeSlots.map((s) => {
          const st = getSlotStatus(s);
          if (st === "completed") return "✅";
          if (st === "noRecord") return "⚠️";
          if (st === "joinable") return "◉";
          return "○";
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

      {/* Slot rows */}
      {visibleSlots.map((slot) => {
        const status = getSlotStatus(slot);
        const isJoinable = status === "joinable";
        const startDate = new Date(slot.startsAt);

        return (
          <div
            key={slot.id}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors",
              isJoinable
                ? "bg-green-50 border border-green-200 cursor-pointer hover:bg-green-100"
                : "bg-zinc-50",
              status === "completed" && "opacity-70",
              status === "noRecord" && "opacity-80",
            )}
            onClick={isJoinable ? () => onJoinSlot(slot) : undefined}
            role={isJoinable ? "button" : undefined}
            tabIndex={isJoinable ? 0 : undefined}
            onKeyDown={
              isJoinable
                ? (e) => e.key === "Enter" && onJoinSlot(slot)
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

            {/* Date + time */}
            <div className="flex-1 min-w-0">
              <span className="font-medium text-zinc-700">
                {format(startDate, "MMM d")}
              </span>
              <span className="text-zinc-400 ml-2">
                {format(startDate, "h:mm a")}
              </span>
            </div>

            {/* Action / status label */}
            {isJoinable ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onJoinSlot(slot);
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
            : `Show all ${nonTentativeSlots.length} sessions`}
        </button>
      )}
    </div>
  );
}
