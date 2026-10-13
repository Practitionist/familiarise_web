"use client";

import { useCallback, useRef, useState } from "react";
import { useCall } from "@stream-io/video-react-sdk";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, LogOut, Phone, PhoneOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import { leaveCallAndReleaseMedia } from "@/lib/stream/media-teardown";
import { useSessionInfo } from "../session-info";

/** Upper bound on POST /api/meetings/[id]/end before releasing local media and navigating away. */
const END_CALL_TIMEOUT_MS = 10_000;
const EARLY_END_WARNING_THRESHOLD_MS = 10 * 60 * 1000;

interface CallExitButtonProps {
  isHost: boolean;
  onLeaveForSelf: () => Promise<void> | void;
  onEnding?: () => void;
}

/**
 * Industry-standard Zoom / Google Meet exit control:
 * - Participants (`!isHost`) see one red "Leave call" button that leaves locally (`call.leave()`).
 * - Hosts (`isHost`) click one red exit button opening a 2-option popover:
 *   1. "Leave call" (leaves locally, keeps room open for consultees and rejoining)
 *   2. "End session for everyone" (terminates Stream room & stamps DB synchronously, with an
 *      inline caution banner if more than 10 minutes remain in the scheduled slot).
 */
export function CallExitButton({
  isHost,
  onLeaveForSelf,
  onEnding,
}: Readonly<CallExitButtonProps>) {
  const call = useCall();
  const router = useRouter();
  const { data: session } = useSession();
  const info = useSessionInfo();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const endingRef = useRef(false);

  const getDashboardUrl = useCallback(() => {
    if (!session?.user) return "/";
    if (info.organizationId) {
      return `/dashboard/organization/${info.organizationId}/appointments`;
    }
    const { role, consultantProfileId, consulteeProfileId, staffProfileId } =
      session.user;
    if (role === "CONSULTANT" && consultantProfileId) {
      return `/dashboard/consultant/${consultantProfileId}/home`;
    }
    if (role === "CONSULTEE" && consulteeProfileId) {
      return `/dashboard/consultee/${consulteeProfileId}/home`;
    }
    if (role === "STAFF" && staffProfileId) {
      return "/dashboard/staff/support";
    }
    return "/";
  }, [info.organizationId, session]);

  const handleEndForEveryone = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    setIsEnding(true);
    onEnding?.();

    try {
      if (call?.id) {
        const response = await fetch(
          `/api/meetings/${encodeURIComponent(call.id)}/end`,
          { method: "POST", signal: AbortSignal.timeout(END_CALL_TIMEOUT_MS) },
        );
        if (!response.ok) {
          throw new Error(`End call failed with status ${response.status}`);
        }
      }
    } catch (error) {
      console.error("Error ending call:", error);
      toast({
        title: "Could not close room cleanly",
        description:
          "Leaving locally instead — the room will close automatically shortly.",
        variant: "destructive",
      });
    } finally {
      try {
        await leaveCallAndReleaseMedia(call);
      } catch (error) {
        console.error("Error releasing media while ending call:", error);
      }
      setIsEnding(false);
      endingRef.current = false;
      setOpen(false);
      router.push(getDashboardUrl());
    }
  }, [call, getDashboardUrl, onEnding, router, toast]);

  if (!isHost) {
    return (
      <button
        type="button"
        onClick={() => void onLeaveForSelf()}
        data-testid="participant-leave-call-button"
        className="p-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors"
        title="Leave call"
        aria-label="Leave call"
      >
        <Phone className="w-5 h-5 rotate-[135deg] text-white" />
      </button>
    );
  }

  const remainingMs = info.endsAt ? info.endsAt.getTime() - Date.now() : 0;
  const remainingMinutes =
    remainingMs > EARLY_END_WARNING_THRESHOLD_MS
      ? Math.round(remainingMs / 60_000)
      : 0;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="host-exit-call-trigger"
          className="p-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors"
          title="Leave or end call"
          aria-label="Leave or end call"
        >
          <Phone className="w-5 h-5 rotate-[135deg] text-white" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        sideOffset={12}
        role="dialog"
        aria-label="Leave or end call options"
        className="w-80 bg-zinc-900 border-zinc-800 p-3.5 rounded-xl text-white shadow-2xl space-y-3"
      >
        <div>
          <p className="text-sm font-semibold text-white">
            End or leave session?
          </p>
          <p className="mt-0.5 text-xs text-zinc-400">
            Choose whether to step out temporarily or close the room for all
            participants.
          </p>
        </div>

        {remainingMinutes > 0 && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <span>
              <strong>{remainingMinutes} min remaining</strong> in this booked
              slot. Ending for everyone disconnects all participants.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isEnding}
            data-testid="host-leave-only-button"
            onClick={() => {
              setOpen(false);
              void onLeaveForSelf();
            }}
            className="h-auto w-full items-start justify-start gap-2.5 whitespace-normal px-3 py-2.5 text-left border-zinc-700 bg-zinc-800/80 text-zinc-100 hover:bg-zinc-800 hover:text-white"
          >
            <LogOut className="h-4 w-4 shrink-0 mt-0.5 text-zinc-300" />
            <div className="flex flex-col items-start text-left">
              <span className="text-xs font-medium">Leave call</span>
              <span className="text-[11px] font-normal text-zinc-400 leading-snug">
                Keep session open for others · Rejoin anytime
              </span>
            </div>
          </Button>

          <Button
            type="button"
            variant="destructive"
            disabled={isEnding}
            data-testid="host-end-for-everyone-button"
            onClick={() => void handleEndForEveryone()}
            className="h-auto w-full items-start justify-start gap-2.5 whitespace-normal px-3 py-2.5 text-left bg-red-600 text-white hover:bg-red-700"
          >
            {isEnding ? (
              <Loader2 className="h-4 w-4 shrink-0 mt-0.5 animate-spin" />
            ) : (
              <PhoneOff className="h-4 w-4 shrink-0 mt-0.5" />
            )}
            <div className="flex flex-col items-start text-left">
              <span className="text-xs font-medium">
                {isEnding ? "Ending session..." : "End session for everyone"}
              </span>
              <span className="text-[11px] font-normal text-red-100/85 leading-snug">
                Disconnects all participants &amp; stops recording
              </span>
            </div>
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default CallExitButton;
