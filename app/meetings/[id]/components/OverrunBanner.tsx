"use client";

import { useEffect, useState } from "react";
import { Clock, PlusCircle, Loader2 } from "lucide-react";
import { CALL_DURATION_GRACE_MS } from "@/lib/meetings/duration-cap";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/utils/tailwind";

const ENDING_SOON_THRESHOLD_MS = 5 * 60 * 1000;
const CAP_IMMINENT_THRESHOLD_MS = 2 * 60 * 1000;

export type OverrunBannerPhase =
  | "hidden"
  | "ending-soon"
  | "overrun-grace"
  | "cap-imminent";

export interface OverrunBannerState {
  phase: OverrunBannerPhase;
  label: string | null;
  untilEndMs: number | null;
  untilCapMs: number | null;
}

/** Pure calculation of the non-intrusive countdown banner state at T-5m, T+0, and Cap-2m. */
export function computeOverrunBannerState(args: {
  startsAt: Date | null;
  endsAt: Date | null;
  extendedSeconds?: number;
  now: Date;
}): OverrunBannerState {
  const { endsAt, extendedSeconds = 0, now } = args;
  if (!endsAt) {
    return {
      phase: "hidden",
      label: null,
      untilEndMs: null,
      untilCapMs: null,
    };
  }

  const nowMs = now.getTime();
  const endsAtMs = endsAt.getTime();
  const capEndsAtMs =
    endsAtMs + CALL_DURATION_GRACE_MS + extendedSeconds * 1000;
  const untilEndMs = endsAtMs - nowMs;
  const untilCapMs = capEndsAtMs - nowMs;

  if (untilEndMs > ENDING_SOON_THRESHOLD_MS) {
    return {
      phase: "hidden",
      label: null,
      untilEndMs,
      untilCapMs,
    };
  }

  if (untilEndMs > 0) {
    const minsLeft = Math.max(1, Math.ceil(untilEndMs / 60_000));
    return {
      phase: "ending-soon",
      label: `${minsLeft} min remaining in scheduled slot`,
      untilEndMs,
      untilCapMs,
    };
  }

  if (untilCapMs <= CAP_IMMINENT_THRESHOLD_MS) {
    const minsToClose = Math.max(
      1,
      Math.ceil(Math.max(0, untilCapMs) / 60_000),
    );
    return {
      phase: "cap-imminent",
      label: `Room closes in ${minsToClose} min`,
      untilEndMs,
      untilCapMs,
    };
  }

  const graceMinsTotal = Math.round(
    (CALL_DURATION_GRACE_MS + extendedSeconds * 1000) / 60_000,
  );
  return {
    phase: "overrun-grace",
    label: `In ${graceMinsTotal}m overrun grace window`,
    untilEndMs,
    untilCapMs,
  };
}

interface OverrunBannerProps {
  callId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  extendedSeconds?: number;
  isHost: boolean;
}

export function OverrunBanner({
  callId,
  startsAt,
  endsAt,
  extendedSeconds = 0,
  isHost,
}: OverrunBannerProps) {
  const { toast } = useToast();
  const [now, setNow] = useState(() => new Date());
  const [localExtendedSeconds, setLocalExtendedSeconds] = useState(0);
  const [isExtending, setIsExtending] = useState(false);
  const [hasConflictingNextBooking, setHasConflictingNextBooking] =
    useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const totalExtendedSeconds = Math.max(extendedSeconds, localExtendedSeconds);
  const banner = computeOverrunBannerState({
    startsAt,
    endsAt,
    extendedSeconds: totalExtendedSeconds,
    now,
  });

  if (banner.phase === "hidden" || !banner.label) {
    return null;
  }

  const handleExtend = async () => {
    if (!callId || isExtending || hasConflictingNextBooking) return;
    setIsExtending(true);
    try {
      const response = await fetch(
        `/api/meetings/${encodeURIComponent(callId)}/extend`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));

      if (response.status === 409 && data.hasConflictingNextBooking) {
        setHasConflictingNextBooking(true);
        toast({
          title: "Cannot extend session",
          description:
            data.error || "Another confirmed session starts within 15 minutes.",
          variant: "destructive",
        });
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || "Could not extend session.");
      }

      const added =
        typeof data.addedSeconds === "number" ? data.addedSeconds : 900;
      setLocalExtendedSeconds(
        (prev) => Math.max(prev, totalExtendedSeconds) + added,
      );
      toast({
        title: "Extended by 15 minutes",
        description: "The room duration cap has been extended by 15 minutes.",
      });
    } catch (error) {
      toast({
        title: "Extension failed",
        description:
          error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExtending(false);
    }
  };

  return (
    <div
      data-testid="overrun-banner"
      data-phase={banner.phase}
      className={cn(
        "pointer-events-auto flex items-center gap-3 rounded-xl border px-3.5 py-2 text-xs font-medium shadow-lg backdrop-blur-md",
        banner.phase === "cap-imminent"
          ? "border-red-500/40 bg-red-950/90 text-red-200"
          : "border-amber-500/40 bg-zinc-900/90 text-amber-200",
      )}
    >
      <Clock className="h-3.5 w-3.5 shrink-0" />
      <span>{banner.label}</span>
      {isHost && callId && (
        <button
          type="button"
          onClick={handleExtend}
          disabled={isExtending || hasConflictingNextBooking}
          data-testid="extend-session-button"
          title={
            hasConflictingNextBooking
              ? "Cannot extend: another confirmed session starts within 15 minutes"
              : "Extend room duration cap by 15 minutes for free"
          }
          className="inline-flex items-center gap-1 rounded-lg bg-amber-500/20 px-2.5 py-1 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isExtending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <PlusCircle className="h-3 w-3" />
          )}
          Extend +15m (Free)
        </button>
      )}
    </div>
  );
}
