"use client";

import { Loader2, PhoneOff, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useReopenRoom } from "../hooks/useReopenRoom";

interface LobbyEndedPanelProps {
  meetingId: string;
  isHost: boolean;
  /** Re-runs the join flow, which applies the server's end-reason policy. */
  onCheckAgain: () => void;
}

/** Replaces the Join action when the call ends while someone waits in the lobby. */
export function LobbyEndedPanel({
  meetingId,
  isHost,
  onCheckAgain,
}: Readonly<LobbyEndedPanelProps>) {
  const { reopenRoom, isReopening, reopenError } = useReopenRoom(meetingId);

  return (
    <div data-testid="lobby-ended-panel" role="status" className="mt-6">
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-left">
        <PhoneOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
        <div className="text-sm text-foreground">
          <p className="font-semibold">This room has closed</p>
          <p className="mt-1 text-muted-foreground">
            {isHost
              ? "You can reopen it while the session is still within its window."
              : "If the session is still running, check again. You are let back in when the host reopens the room."}
          </p>
        </div>
      </div>
      {reopenError && (
        <p className="mt-3 text-xs text-red-600" role="alert">
          {reopenError}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {isHost && (
          <Button
            onClick={() => void reopenRoom()}
            disabled={isReopening}
            data-testid="lobby-reopen-button"
            className="h-11 w-full rounded-xl"
          >
            {isReopening ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="mr-2 h-4 w-4" />
            )}
            {isReopening ? "Reopening Room…" : "Reopen Session Room"}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={onCheckAgain}
          data-testid="lobby-ended-check-again"
          className="h-11 w-full rounded-xl"
        >
          Check again
        </Button>
      </div>
    </div>
  );
}
