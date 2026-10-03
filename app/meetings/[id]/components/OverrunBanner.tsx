"use client";

import { useEffect, useState } from "react";
import { useCallStateHooks } from "@stream-io/video-react-sdk";
import { Clock, PlusCircle, Loader2 } from "lucide-react";
import {
  CALL_DURATION_GRACE_MS,
  resolveMaxCallDurationSeconds,
} from "@/lib/meetings/duration-cap";
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/utils/tailwind";

const ENDING_SOON_THRESHOLD_MS = 5 * 60 * 1000;
const CAP_IMMINENT_THRESHOLD_MS = 2 * 60 * 1000;
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;
const useDefaultCallSession = () => undefined;

export type OverrunBannerPhase =
  "hidden" | "ending-soon" | "overrun-grace" | "cap-imminent";

export interface OverrunBannerState {
  phase: OverrunBannerPhase;
  label: string | null;
  untilEndMs: number | null;
  untilCapMs: number | null;
}

function resolveCapEndsAtMs(args: {
  startsAt: Date | null;
  endsAt: Date;
  extendedSeconds: number;
  timerEndsAt?: Date | string | null;
}): number {
  if (args.timerEndsAt) {
    const parsed =
      args.timerEndsAt instanceof Date
        ? args.timerEndsAt.getTime()
        : new Date(args.timerEndsAt).getTime();
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  if (args.startsAt) {
    const capSeconds =
      resolveMaxCallDurationSeconds({ endsAt: args.endsAt }, args.startsAt) ??
      Math.ceil(CALL_DURATION_GRACE_MS / 1000);
    return (
      args.startsAt.getTime() -
      CONSULTANT_JOIN_WINDOW_MS +
      (capSeconds + args.extendedSeconds) * 1000
    );
  }
  return (
    args.endsAt.getTime() + CALL_DURATION_GRACE_MS + args.extendedSeconds * 1000
  );
}

/** Pure calculation of the non-intrusive countdown banner state at T-5m, T+0, and Cap-2m. */
export function computeOverrunBannerState(args: {
  startsAt: Date | null;
  endsAt: Date | null;
  extendedSeconds?: number;
  timerEndsAt?: Date | string | null;
  now: Date;
}): OverrunBannerState {
  const { startsAt, endsAt, extendedSeconds = 0, timerEndsAt, now } = args;
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
  const capEndsAtMs = resolveCapEndsAtMs({
    startsAt,
    endsAt,
    extendedSeconds,
    timerEndsAt,
  });
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

  const graceMinsTotal = Math.max(
    1,
    Math.round((capEndsAtMs - endsAtMs) / 60_000),
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
  extensionsUsed?: number;
  isHost: boolean;
}

export function OverrunBanner({
  callId,
  startsAt,
  endsAt,
  extendedSeconds = 0,
  extensionsUsed = 0,
  isHost,
}: Readonly<OverrunBannerProps>) {
  const { toast } = useToast();
  const hooks = useCallStateHooks();
  const useCallSession = hooks.useCallSession ?? useDefaultCallSession;
  const session = useCallSession();
  const [now, setNow] = useState(() => new Date());
  const [localExtendedSeconds, setLocalExtendedSeconds] = useState(0);
  const [alreadyExtended, setAlreadyExtended] = useState(false);
  const [isExtending, setIsExtending] = useState(false);
  const [hasConflictingNextBooking, setHasConflictingNextBooking] =
    useState(false);

  const totalExtendedSeconds = Math.max(extendedSeconds, localExtendedSeconds);
  const isAlreadyExtended =
    alreadyExtended || extensionsUsed >= 1 || totalExtendedSeconds > 0;
  const banner = computeOverrunBannerState({
    startsAt,
    endsAt,
    extendedSeconds: totalExtendedSeconds,
    timerEndsAt: localExtendedSeconds > 0 ? null : session?.timer_ends_at,
    now,
  });

  useEffect(() => {
    if (!endsAt) return;
    if (banner.phase === "hidden") {
      const delayMs = Math.min(
        Math.max(0, endsAt.getTime() - Date.now() - ENDING_SOON_THRESHOLD_MS) +
          50,
        MAX_TIMEOUT_DELAY_MS,
      );
      const timeoutId = setTimeout(() => setNow(new Date()), delayMs);
      return () => clearTimeout(timeoutId);
    }
    const intervalId = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(intervalId);
  }, [endsAt, banner.phase]);

  if (banner.phase === "hidden" || !banner.label) {
    return null;
  }

  const handleExtend = async () => {
    if (
      !callId ||
      isExtending ||
      hasConflictingNextBooking ||
      isAlreadyExtended
    )
      return;
    setIsExtending(true);
    try {
      const response = await fetch(
        `/api/meetings/${encodeURIComponent(callId)}/extend`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));

      if (response.status === 409 && data.alreadyExtended) {
        setAlreadyExtended(true);
        toast({
          title: "Extension already used",
          description:
            data.error ||
            "Free +15m extension has already been used for this session.",
          variant: "destructive",
        });
        return;
      }

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
      setAlreadyExtended(true);
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
      {isHost &&
        callId &&
        (isAlreadyExtended ? (
          <span
            data-testid="extended-badge"
            className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/20 px-2.5 py-1 text-xs font-semibold text-emerald-200"
          >
            Extended (+15m applied)
          </span>
        ) : (
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
        ))}
    </div>
  );
}
