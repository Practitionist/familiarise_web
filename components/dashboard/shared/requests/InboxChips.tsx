"use client";

import { Button } from "@/components/ui/button";
import type {
  InboxChip,
  InboxType,
} from "@/lib/dashboard/requests-inbox-state";
import { cn } from "@/utils/tailwind";

import { CHIP_LABEL, CHIPS_FOR_TYPE } from "./labels";

/** The filter chips one tab offers; one active at a time, none = the whole tab. */
export function InboxChips({
  type,
  active,
  disabled,
  onChange,
}: Readonly<{
  type: InboxType;
  active: InboxChip | null;
  disabled: boolean;
  onChange: (chip: InboxChip | null) => void;
}>) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter">
      {CHIPS_FOR_TYPE[type].map((chip) => {
        const on = active === chip;
        return (
          <Button
            key={chip}
            type="button"
            size="sm"
            variant={on ? "default" : "outline"}
            aria-pressed={on}
            disabled={disabled}
            className={cn(
              "h-8 rounded-full px-3 text-xs",
              !on && "bg-background",
            )}
            onClick={() => onChange(on ? null : chip)}
          >
            {CHIP_LABEL[chip]}
          </Button>
        );
      })}
    </div>
  );
}
