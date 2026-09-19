"use client";

/**
 * The legend the slot grids never had.
 *
 * Three surfaces coloured cells in four different states and none of them said
 * what the colours meant — a consultant seeing a yellow cell had to guess
 * whether it was bookable. Driven off SLOT_STATUS_TOKENS, so a new state cannot
 * be introduced without appearing here.
 */

import { cn } from "@/utils/tailwind";
import {
  SLOT_STATUS_TOKENS,
  type SlotStatusKey,
} from "@/lib/scheduling/interval-status-tokens";

interface SlotStatusLegendProps {
  keys: SlotStatusKey[];
  className?: string;
  /**
   * Live cell counts per state for the painted week. Shown as a suffix
   * ("Available · 12") so the key doubles as a salience readout; absent
   * (still loading) renders the plain key with no count.
   */
  counts?: ReadonlyMap<SlotStatusKey, number>;
}

export function SlotStatusLegend({
  keys,
  className,
  counts,
}: Readonly<SlotStatusLegendProps>) {
  return (
    // Sticky so a tall grid that scrolls the page keeps its key in view; in a
    // height-bound shell (the allocate page) it simply stays put (#1703 F4).
    <ul
      className={cn(
        "sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 bg-background",
        className,
      )}
      aria-label="What the colours mean"
    >
      {keys.map((key) => {
        const token = SLOT_STATUS_TOKENS[key];
        const count = counts?.get(key);
        const label =
          count === undefined
            ? token.label
            : `${token.label} · ${count}`;
        return (
          <li
            key={key}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title={token.hint}
            role="img"
            aria-label={`${token.label}: ${token.hint}${count === undefined ? "" : `, ${count} slots this week`}`}
          >
            {/* No border-COLOUR of its own: `swatchClassName` carries the
                cell's, and a hardcoded one here would win or lose by
                stylesheet order rather than by intent (#1064). */}
            <span
              aria-hidden
              className={cn(
                "h-3.5 w-3.5 shrink-0 rounded-sm border",
                token.swatchClassName,
              )}
            />
            <span aria-hidden>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}
