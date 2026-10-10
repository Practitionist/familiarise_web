"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  CheckCircle2,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

import { CONSULTEE_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";
import { useSession } from "@/lib/auth-client";
import type { MeetingAccessResult } from "../hooks/useGetCallById";
import { formatScheduledAt } from "../session-info";

interface MeetingLobbyGateCardProps {
  meetingId: string;
  access: MeetingAccessResult;
  onRetryJoin: () => void;
}

function formatOpenCountdown(msUntilOpen: number): string {
  const totalSec = Math.max(0, Math.ceil(msUntilOpen / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  }
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

/**
 * Renders state-aware lobby screens when `/api/meetings/[id]/join` refuses entry:
 * - `TOO_EARLY`: Calm pre-session waiting card with schedule in viewer timezone & auto-entry when buffer opens.
 * - `SESSION_ENDED`: Clean session-concluded card with Host "Reopen Session Room" safety valve inside window.
 * - Default: Security Access Denied shield for unauthorized callers.
 */
export function MeetingLobbyGateCard({
  meetingId,
  access,
  onRetryJoin,
}: MeetingLobbyGateCardProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isReopening, setIsReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  const startsAt = access.startsAt ? new Date(access.startsAt) : null;
  const openAtMs = startsAt
    ? startsAt.getTime() - CONSULTEE_JOIN_WINDOW_MS
    : null;

  useEffect(() => {
    if (access.code !== "TOO_EARLY" || openAtMs === null) return;
    const id = window.setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      if (current >= openAtMs) {
        window.clearInterval(id);
        onRetryJoin();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [access.code, openAtMs, onRetryJoin]);

  const scheduledLabel = formatScheduledAt(
    startsAt,
    session?.user?.timezone ?? null,
  );

  const handleReopenRoom = async () => {
    setReopenError(null);
    setIsReopening(true);
    try {
      const res = await fetch(
        `/api/meetings/${encodeURIComponent(meetingId)}/reopen`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        reopened?: boolean;
        streamCallId?: string;
        error?: string;
      };
      if (!res.ok || !data.streamCallId) {
        setReopenError(
          data.error ?? "Could not reopen session room. Please try again.",
        );
        setIsReopening(false);
        return;
      }
      router.replace(`/meetings/${encodeURIComponent(data.streamCallId)}`);
    } catch {
      setReopenError("Network error while reopening session room.");
      setIsReopening(false);
    }
  };

  if (access.code === "TOO_EARLY") {
    const msUntilOpen = openAtMs !== null ? openAtMs - nowMs : null;
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-muted p-4">
        <div className="w-full max-w-md bg-card p-8 rounded-2xl shadow-xl border border-border text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <CalendarClock className="w-8 h-8 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-xl font-bold text-foreground mb-2">
            Room Not Open Yet
          </h2>
          {scheduledLabel && (
            <p className="text-sm font-medium text-foreground mb-1">
              Scheduled for {scheduledLabel}
            </p>
          )}
          <p className="text-muted-foreground mb-4">{access.message}</p>
          {msUntilOpen !== null && msUntilOpen > 0 && (
            <p
              data-testid="early-lobby-countdown"
              className="mb-5 inline-flex items-center rounded-lg bg-muted px-3 py-1.5 text-xs font-semibold tabular-nums text-foreground"
            >
              Room opens automatically in {formatOpenCountdown(msUntilOpen)}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onRetryJoin}
              className="px-6 py-2.5 bg-foreground text-background rounded-lg font-medium hover:bg-foreground/90 transition-colors"
            >
              Check Again
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="px-6 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Back to Appointments
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (access.code === "SESSION_ENDED") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-muted p-4">
        <div className="w-full max-w-md bg-card p-8 rounded-2xl shadow-xl border border-border text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
            <CheckCircle2 className="w-8 h-8 text-zinc-600 dark:text-zinc-300" />
          </div>
          <h2 className="text-xl font-bold text-foreground mb-2">
            Session Has Ended
          </h2>
          <p className="text-muted-foreground mb-4">
            This video room has been closed.
          </p>
          {reopenError && (
            <p className="mb-4 text-xs text-red-600" role="alert">
              {reopenError}
            </p>
          )}
          <div className="flex flex-col gap-2.5">
            {access.canReopen && (
              <button
                type="button"
                disabled={isReopening}
                data-testid="reopen-ended-session-button"
                onClick={() => void handleReopenRoom()}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-foreground text-background rounded-lg font-medium hover:bg-foreground/90 transition-colors disabled:opacity-60"
              >
                <RotateCcw className="h-4 w-4" />
                {isReopening ? "Reopening Room…" : "Reopen Session Room"}
              </button>
            )}
            <button
              type="button"
              onClick={() => window.history.back()}
              className="px-6 py-2.5 border border-border bg-card text-foreground rounded-lg font-medium hover:bg-muted transition-colors"
            >
              Back to Appointments
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-muted p-4">
      <div className="w-full max-w-md bg-card p-8 rounded-2xl shadow-xl border border-border text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
          <ShieldAlert className="w-8 h-8 text-red-600" />
        </div>
        <h2 className="text-xl font-bold text-foreground mb-2">
          Access Denied
        </h2>
        <p className="text-muted-foreground mb-4">{access.message}</p>
        <p className="text-sm text-muted-foreground/70">
          If you believe this is an error, please contact support or the meeting
          host.
        </p>
        <button
          type="button"
          onClick={() => window.history.back()}
          className="mt-6 px-6 py-2.5 bg-foreground text-background rounded-lg font-medium hover:bg-foreground/90 transition-colors"
        >
          Go Back
        </button>
      </div>
    </div>
  );
}
