"use client";

import { useEffect, useState } from "react";
import { useCallStateHooks } from "@stream-io/video-react-sdk";
import { useSession } from "@/lib/auth-client";

/** Reads session metadata from Stream call `custom` data into a normalized view model for meeting screens. */

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function date(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toTypeLabel(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  return raw
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface SessionInfo {
  counterpartName: string | null;
  offeringTitle: string | null;
  appointmentType: string | null;
  typeLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  durationMinutes: number | null;
  extendedSeconds: number;
  extensionsUsed: number;
  organizationId: string | null;
  fallbackTitle: string;
  isHost: boolean;
}

function resolveExtensionsUsed(raw: unknown, extendedSeconds: number): number {
  if (typeof raw === "number" && raw > 0) return raw;
  return extendedSeconds > 0 ? 1 : 0;
}

/** Derives the current viewer's session role and metadata from Stream call custom data and server admission role. */
export function useSessionInfo(
  serverRole?: "host" | "participant" | null,
): SessionInfo {
  const { useCallCustomData } = useCallStateHooks();
  const custom = useCallCustomData();
  const { data: session } = useSession();

  const consultantUserId = str(custom?.consultantUserId);
  const hostUserIds = Array.isArray(custom?.hostUserIds)
    ? custom.hostUserIds.filter((id): id is string => typeof id === "string")
    : [];

  const me = session?.user?.id;
  let isHost: boolean;
  if (serverRole === "host" || serverRole === "participant") {
    isHost = serverRole === "host";
  } else if (hostUserIds.length > 0) {
    isHost = Boolean(me) && hostUserIds.includes(me as string);
  } else if (consultantUserId) {
    isHost = me === consultantUserId;
  } else {
    isHost = session?.user?.role === "CONSULTANT";
  }

  const hostName = str(custom?.hostName);
  const guestName = str(custom?.guestName);

  const startsAt = date(custom?.sessionStartsAt);
  const endsAt = date(custom?.sessionEndsAt);
  const stampedDuration =
    typeof custom?.sessionDurationMinutes === "number"
      ? custom.sessionDurationMinutes
      : null;
  const extendedSeconds =
    typeof custom?.extendedSeconds === "number" && custom.extendedSeconds > 0
      ? custom.extendedSeconds
      : 0;
  const extensionsUsed = resolveExtensionsUsed(
    custom?.extensionsUsed,
    extendedSeconds,
  );
  const organizationId = str(custom?.organizationId);

  return {
    counterpartName: isHost ? guestName : hostName,
    offeringTitle: str(custom?.offeringTitle),
    appointmentType: str(custom?.appointmentType),
    typeLabel: toTypeLabel(custom?.appointmentType),
    startsAt,
    endsAt,
    durationMinutes:
      stampedDuration ??
      (startsAt && endsAt
        ? Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000)
        : null),
    extendedSeconds,
    extensionsUsed,
    organizationId,
    fallbackTitle: str(custom?.title) ?? "Meeting",
    isHost,
  };
}

export function sessionHeading(info: SessionInfo): string {
  return info.counterpartName ?? info.offeringTitle ?? info.fallbackTitle;
}

export function sessionSubheading(info: SessionInfo): string | null {
  if (!info.counterpartName) return null;
  return info.offeringTitle;
}

import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";

export function formatScheduledAt(
  startsAt: Date | null,
  zone?: string | null,
): string | null {
  if (!startsAt) return null;
  const resolvedZone =
    zone ||
    (typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC") ||
    "UTC";
  const tz = zoneLabel(startsAt, resolvedZone);
  const time = `${formatInViewerZone(startsAt, resolvedZone, "h:mm a")} ${tz}`;
  const dayKey = formatInViewerZone(startsAt, resolvedZone, "yyyy-MM-dd");
  const nowMs = Date.now();
  const todayKey = formatInViewerZone(nowMs, resolvedZone, "yyyy-MM-dd");
  const tomorrowKey = formatInViewerZone(
    nowMs + 86_400_000,
    resolvedZone,
    "yyyy-MM-dd",
  );
  if (dayKey === todayKey) return `Today at ${time}`;
  if (dayKey === tomorrowKey) return `Tomorrow at ${time}`;
  return `${formatInViewerZone(startsAt, resolvedZone, "EEE d MMM")} at ${time}`;
}

export type SessionPhase =
  "unknown" | "early" | "starting-soon" | "in-progress" | "overrunning";

export interface SessionClock {
  phase: SessionPhase;
  status: string | null;
  elapsed: string | null;
  elapsedLabel: string | null;
  remaining: string | null;
}

const STARTING_SOON_MS = 10 * 60 * 1000;

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function minutesLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function readClock(
  startsAt: Date | null,
  endsAt: Date | null,
  now: Date,
): SessionClock {
  if (!startsAt) {
    return {
      phase: "unknown",
      status: null,
      elapsed: null,
      elapsedLabel: null,
      remaining: null,
    };
  }

  const sinceStart = now.getTime() - startsAt.getTime();
  const untilEnd = endsAt ? endsAt.getTime() - now.getTime() : null;

  if (sinceStart < 0) {
    const untilStart = -sinceStart;
    return {
      phase: untilStart <= STARTING_SOON_MS ? "starting-soon" : "early",
      status: `Starts in ${minutesLabel(untilStart)}`,
      elapsed: null,
      elapsedLabel: null,
      remaining: null,
    };
  }

  const elapsed = formatClock(sinceStart);

  if (untilEnd !== null && untilEnd <= 0) {
    return {
      phase: "overrunning",
      status: `${minutesLabel(-untilEnd)} over`,
      elapsed,
      elapsedLabel: `${elapsed} elapsed`,
      remaining: null,
    };
  }

  const remaining = untilEnd === null ? null : `${minutesLabel(untilEnd)} left`;
  return {
    phase: "in-progress",
    status: remaining ?? "In progress",
    elapsed,
    elapsedLabel: `${elapsed} elapsed`,
    remaining,
  };
}

export function useSessionClock(
  startsAt: Date | null,
  endsAt: Date | null,
): SessionClock {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return readClock(startsAt, endsAt, now);
}
