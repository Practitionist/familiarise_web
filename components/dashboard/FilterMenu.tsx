"use client";

import { Check, ChevronDown, X } from "lucide-react";
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/utils/tailwind";

export interface FilterMenuOption {
  value: string;
  label: string;
  count?: number;
}

export interface FilterMenuProps {
  /** The filter's name, shown on the trigger ("Type: All") and used as its accessible name. */
  label: string;
  options: FilterMenuOption[];
  /** The picked option, or `null` when nothing is picked. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** The option that means "no filter"; picking it shows the trigger as inactive. */
  allValue?: string | null;
  /** The trigger text when nothing is picked and there is no "all" option. */
  allLabel?: string;
  /** Disables the trigger and the clear button, e.g. while the list loads. */
  disabled?: boolean;
  /** Fired on pointer-enter or focus of an option with the value a click would pick (for prefetch). */
  onOptionIntent?: (value: string | null) => void;
}

const TRIGGER =
  "inline-flex h-9 items-center gap-1.5 whitespace-nowrap border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * One filter as a compact "Label: Value" menu. An active filter turns dark and
 * gets its own clear button (a sibling, since a button cannot nest in a button).
 */
export function FilterMenu({
  label,
  options,
  value,
  onChange,
  allValue = null,
  allLabel = "All",
  disabled = false,
  onOptionIntent,
}: Readonly<FilterMenuProps>) {
  const [open, setOpen] = useState(false);
  // With an own "all" option, `null` means a pick the list cannot show (several values).
  const active = allValue === null ? value !== null : value !== allValue;
  const picked = options.find((o) => o.value === value);
  const shown = active ? (picked?.label ?? value ?? "Several") : allLabel;
  // A list with its own "all" option offers that; otherwise "All" maps to null.
  const items: FilterMenuOption[] =
    allValue !== null && options.some((o) => o.value === allValue)
      ? options
      : [{ value: "", label: allLabel }, ...options];

  return (
    <div className="inline-flex">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${label}: ${shown}`}
            disabled={disabled}
            className={cn(
              TRIGGER,
              "disabled:pointer-events-none disabled:opacity-50",
              active
                ? "rounded-l-lg border-foreground bg-foreground pl-3 pr-2 text-background"
                : "rounded-lg border-border bg-card px-3 text-foreground hover:border-foreground/30",
            )}
          >
            <span className={cn(!active && "text-muted-foreground")}>
              {label}:
            </span>
            <span className="font-semibold">{shown}</span>
            {!active && (
              <ChevronDown
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-1" aria-label={label}>
          <fieldset aria-label={label} className="m-0 min-w-0 border-0 p-0">
            {items.map((option) => {
              const selected =
                option.value === "" ? value === null : option.value === value;
              // In a clearable group, picking the current pick again clears it, as the chips did.
              const clears =
                option.value === "" ||
                (allValue === null && selected && active);
              const next = clears ? allValue : option.value;
              return (
                <button
                  key={option.value || "__all"}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    onChange(next);
                    setOpen(false);
                  }}
                  onPointerEnter={() => onOptionIntent?.(next)}
                  onFocus={() => onOptionIntent?.(next)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    selected && "font-semibold",
                  )}
                >
                  <span className="flex-1">{option.label}</span>
                  {option.count !== undefined && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {option.count}
                    </span>
                  )}
                  <Check
                    className={cn("h-3.5 w-3.5", !selected && "invisible")}
                    aria-hidden
                  />
                </button>
              );
            })}
          </fieldset>
        </PopoverContent>
      </Popover>
      {active && (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()} filter`}
          disabled={disabled}
          onClick={() => onChange(allValue)}
          className={cn(
            TRIGGER,
            "disabled:pointer-events-none disabled:opacity-50",
            "rounded-r-lg border-l-0 border-foreground bg-foreground pl-1 pr-2.5 text-background/70 hover:text-background",
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
