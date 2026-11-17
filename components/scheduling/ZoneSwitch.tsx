"use client";

import { Globe } from "lucide-react";

import { canonicalZone, zoneDisplayLabel } from "@/lib/time/viewer-zone";
import { cn } from "@/utils/tailwind";

export interface ZoneSwitchProps {
  /** The zone the times on screen are drawn in. */
  zone: string;
  /** Whether the viewer has switched to the device zone. */
  usingDeviceZone: boolean;
  /** False hides the switch (no profile zone, or it equals the device zone). */
  canSwitch: boolean;
  onToggle: () => void;
  /** The wall clock the zone label is read at (DST-dependent abbreviation). */
  now?: Date;
  className?: string;
}

/**
 * "Times shown in IST (UTC+05:30) · Use my device's time zone". Every grid
 * and the booking dialog carry it, so the zone is never a guess.
 */
export function ZoneSwitch({
  zone,
  usingDeviceZone,
  canSwitch,
  onToggle,
  now,
  className,
}: Readonly<ZoneSwitchProps>) {
  const label = zoneDisplayLabel(now ?? new Date(), zone);
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
      data-testid="zone-switch"
    >
      <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span title={canonicalZone(zone)}>Times shown in {label}</span>
      {canSwitch && (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onToggle}
            aria-pressed={usingDeviceZone}
            className="inline-flex min-h-9 items-center rounded-sm font-medium text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
          >
            {usingDeviceZone
              ? "Use my profile time zone"
              : "Use my device's time zone"}
          </button>
        </>
      )}
    </p>
  );
}
