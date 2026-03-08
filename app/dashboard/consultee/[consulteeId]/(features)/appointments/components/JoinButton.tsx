"use client";

import { Button } from "@/components/ui/button";
import { Video, Loader2 } from "lucide-react";
import { cn } from "@/utils/tailwind";
import type { SlotOfAppointment } from "@prisma/client";

const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000;

interface JoinButtonProps {
  slot: SlotOfAppointment | null;
  isJoining: boolean;
  onJoin: () => void;
  disabled?: boolean;
}

function getJoinState(
  slot: SlotOfAppointment | null,
): "disabled" | "countdown" | "joinable" | "ended" {
  if (!slot || slot.isTentative) return "disabled";

  const now = Date.now();
  const start = new Date(slot.startsAt).getTime();
  const end = slot.endsAt
    ? new Date(slot.endsAt).getTime()
    : start + DEFAULT_MEETING_DURATION_MS;
  const joinWindow = start - 10 * 60 * 1000;

  if (now > end) return "ended";
  if (now >= joinWindow) return "joinable";
  return "countdown";
}

export function JoinButton({
  slot,
  isJoining,
  onJoin,
  disabled = false,
}: JoinButtonProps) {
  const state = getJoinState(slot);
  const isJoinable = state === "joinable";

  return (
    <Button
      onClick={onJoin}
      disabled={!isJoinable || isJoining || disabled}
      className={cn(
        "w-full h-9 font-medium text-sm",
        isJoinable && !isJoining
          ? "bg-zinc-900 hover:bg-zinc-800 text-white"
          : "bg-zinc-100 text-zinc-400 cursor-not-allowed",
      )}
    >
      {isJoining ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Joining...
        </>
      ) : state === "ended" ? (
        "Session Ended"
      ) : (
        <>
          <Video className="h-4 w-4 mr-2" />
          {isJoinable ? "JOIN NOW" : "Join Session"}
        </>
      )}
    </Button>
  );
}
