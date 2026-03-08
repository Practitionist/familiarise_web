"use client";

import { useEffect, useState } from "react";
import { cn } from "@/utils/tailwind";

interface CountdownBadgeProps {
  targetDate: Date | string;
  sessionEndDate?: Date | string;
}

type Tier = "far" | "soon" | "imminent" | "now" | "live" | "ended";

function getTier(diffMs: number, isOngoing: boolean): Tier {
  if (isOngoing) return "live";
  if (diffMs <= 0) return "now";
  const minutes = diffMs / 60000;
  if (minutes <= 10) return "now";
  if (minutes <= 30) return "imminent";
  if (minutes <= 180) return "soon";
  return "far";
}

function formatCountdown(diffMs: number): string {
  if (diffMs <= 0) return "NOW";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const tierStyles: Record<Tier, string> = {
  far: "bg-zinc-100 text-zinc-500",
  soon: "bg-amber-50 text-amber-600",
  imminent: "bg-orange-50 text-orange-600",
  now: "bg-green-50 text-green-600 animate-pulse",
  live: "bg-red-50 text-red-600 animate-pulse",
  ended: "bg-zinc-100 text-zinc-400",
};

export function CountdownBadge({
  targetDate,
  sessionEndDate,
}: CountdownBadgeProps) {
  const [now, setNow] = useState(() => Date.now());

  const target = new Date(targetDate).getTime();
  const end = sessionEndDate ? new Date(sessionEndDate).getTime() : null;
  const diffMs = target - now;
  const isOngoing = diffMs <= 0 && end != null && now <= end;
  const isEnded = end != null && now > end;

  useEffect(() => {
    if (isEnded) return;

    // Adjust timer frequency based on proximity
    const minutes = Math.abs(diffMs) / 60000;
    let interval: number;
    if (minutes <= 1) interval = 1000; // every second when very close
    else if (minutes <= 30) interval = 10000; // every 10s when imminent
    else if (minutes <= 180) interval = 60000; // every minute when soon
    else interval = 300000; // every 5 minutes when far

    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [diffMs, isEnded]);

  if (isEnded) return null;

  const tier = getTier(diffMs, isOngoing);
  const label = isOngoing ? "LIVE" : formatCountdown(diffMs);

  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums",
        tierStyles[tier],
      )}
    >
      {label}
    </span>
  );
}
