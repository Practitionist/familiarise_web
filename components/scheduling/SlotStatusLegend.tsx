"use client";

/**
 * The key for every time grid, driven off SLOT_STATUS_TOKENS so a new state
 * cannot be painted without appearing here. Each swatch repeats the cell's
 * pattern and glyph, so the key works without colour too.
 */

import { SlotStatusIcon } from "@/components/scheduling/SlotStatusIcon";
import {
  REQUESTED_OUTLINE,
  SLOT_STATUS_TOKENS,
  type SlotStatusKey,
} from "@/lib/scheduling/interval-status-tokens";
import { cn } from "@/utils/tailwind";

interface SlotStatusLegendProps {
  keys: SlotStatusKey[];
  className?: string;
  /**
   * Live cell counts per state for the painted week, shown as a suffix
   * ("Free · 12"); absent while loading.
   */
  counts?: ReadonlyMap<SlotStatusKey, number>;
  /** Adds the "Requested" outline row (allocate grid only). */
  showRequested?: boolean;
}

function halfHours(count: number): string {
  return `${count} half-hour${count === 1 ? "" : "s"} this week`;
}

export function SlotStatusLegend({
  keys,
  className,
  counts,
  showRequested = false,
}: Readonly<SlotStatusLegendProps>) {
  return (
    <ul
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}
      aria-label="What the colours and patterns mean"
    >
      {keys.map((key) => {
        const token = SLOT_STATUS_TOKENS[key];
        const count = counts?.get(key);
        return (
          <li
            key={key}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title={token.hint}
          >
            <span
              aria-hidden="true"
              data-legend-swatch={key}
              className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border",
                token.swatchClassName,
                token.text,
              )}
            >
              <SlotStatusIcon name={token.icon} className="h-2 w-2" />
            </span>
            <span aria-hidden>
              {count === undefined ? token.label : `${token.label} · ${count}`}
            </span>
            <span className="sr-only">
              {`${token.label}: ${token.hint}${count === undefined ? "" : `, ${halfHours(count)}`}`}
            </span>
          </li>
        );
      })}
      {showRequested && (
        <li
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title={REQUESTED_OUTLINE.hint}
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-3.5 w-3.5 shrink-0 rounded-sm",
              REQUESTED_OUTLINE.swatchClassName,
            )}
          />
          <span aria-hidden>{REQUESTED_OUTLINE.label}</span>
          <span className="sr-only">
            {`${REQUESTED_OUTLINE.label}: ${REQUESTED_OUTLINE.hint}`}
          </span>
        </li>
      )}
    </ul>
  );
}
