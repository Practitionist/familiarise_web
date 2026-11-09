"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/utils/tailwind";

/** One picked session in the tray, already labelled in the grid's zone. */
export interface TrayPick {
  key: string;
  /** "Thu 13 Nov · 6:30 pm–7:30 pm". */
  label: string;
  /** Absent when the pick cannot be removed from here. */
  onRemove?: () => void;
}

/** A labelled meter row: "This week · 2 of 3 booked". */
export interface TrayMeter {
  label: string;
  value: string;
  /** 0–1; omitted for a text-only row such as the per-day cap. */
  fraction?: number;
}

export interface SessionTrayProps {
  /** The progress sentence; a button when it can scroll to the picks. */
  heading: ReactNode;
  picked: number;
  needed: number;
  picks: readonly TrayPick[];
  meters?: readonly TrayMeter[];
  /** Plan-level warnings (feasibility), shown above the legend. */
  warnings?: string[];
  legend?: ReactNode;
  /** Freshness and zone notes, small print under the legend. */
  status?: ReactNode;
  /** The screen-reader progress line, announced politely. */
  liveText: string;
  actions?: ReactNode;
  className?: string;
}

function Meter({ fraction }: Readonly<{ fraction: number }>) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-emerald-700"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * The scheduling grid's side panel: numbered picks with remove buttons, the
 * plan meters, warnings, the legend and the actions. Docked right of the grid
 * from 1280px, under it below that, so the grid keeps the height.
 */
export function SessionTray({
  heading,
  picked,
  needed,
  picks,
  meters = [],
  warnings = [],
  legend,
  status,
  liveText,
  actions,
  className,
}: Readonly<SessionTrayProps>) {
  return (
    <aside
      aria-label="Your picks"
      data-testid="session-tray"
      className={cn(
        "flex shrink-0 flex-col gap-3 rounded-lg border border-border bg-card p-3 xl:w-80 xl:overflow-y-auto",
        className,
      )}
    >
      <div className="space-y-2">
        <div className="text-sm font-semibold">{heading}</div>
        {needed > 0 && <Meter fraction={picked / needed} />}
      </div>

      {meters.length > 0 && (
        <dl className="space-y-1.5 text-xs">
          {meters.map((meter) => (
            <div key={meter.label} className="space-y-1">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{meter.label}</dt>
                <dd className="text-right font-medium">{meter.value}</dd>
              </div>
              {meter.fraction !== undefined && (
                <Meter fraction={meter.fraction} />
              )}
            </div>
          ))}
        </dl>
      )}

      <ol aria-label="Picked times" className="space-y-1.5">
        {picks.map((pick, index) => (
          <li
            key={pick.key}
            title={pick.label}
            className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
          >
            <span className="min-w-0">
              <span className="font-semibold">Session {index + 1}</span>
              {` · ${pick.label}`}
            </span>
            {pick.onRemove && (
              <button
                type="button"
                onClick={pick.onRemove}
                aria-label={`Remove session ${index + 1}, ${pick.label}`}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
        {picked < needed && (
          <li className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
            <span className="font-semibold">Session {picks.length + 1}</span>
            {" · point at a free time to preview it, then click to place it"}
          </li>
        )}
      </ol>

      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {legend}

      {status && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          {status}
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {liveText}
      </div>

      {actions && (
        <div className="sticky bottom-0 mt-auto flex flex-wrap justify-end gap-2 border-t border-border bg-card pt-3">
          {actions}
        </div>
      )}
    </aside>
  );
}
