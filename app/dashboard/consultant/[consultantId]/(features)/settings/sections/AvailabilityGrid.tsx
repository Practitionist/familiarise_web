"use client";

import { Button } from "components/ui/button";
import { Input } from "components/ui/input";
import { Label } from "components/ui/label";
import { TrashIcon } from "assets/icons";
import type { SlotsType } from "@/utils/schedule/types";

interface AvailabilityGridProps {
  /** Slot-map key: lowercase weekday ("monday") or date string ("2026-07-02"). */
  dayKey: string;
  /** Human-readable heading for the row group. */
  label: string;
  slots: SlotsType[string] | undefined;
  onAddSlot: (dayKey: string) => void;
  onUpdateSlot: (
    dayKey: string,
    index: number,
    field: "startTime" | "endTime",
    value: string,
  ) => void;
  onDeleteSlot: (dayKey: string, index: number) => void;
}

/**
 * One day/date's worth of availability slot rows — the hand-built
 * time-grid extracted from the settings monolith. Purely presentational:
 * validation and state transitions stay with the caller (SettingsTab),
 * which passes validated slots back down. Used identically by the weekly
 * and custom schedule columns.
 */
export function AvailabilityGrid({
  dayKey,
  label,
  slots,
  onAddSlot,
  onUpdateSlot,
  onDeleteSlot,
}: AvailabilityGridProps) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <Label>{label}</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onAddSlot(dayKey)}
        >
          Add Slot
        </Button>
      </div>
      {slots?.map((slot, slotIndex) => (
        <div key={`${dayKey}-${slotIndex}`} className="space-y-2">
          <div className="grid grid-cols-7 gap-2 items-center">
            <Input
              type="time"
              value={slot.startTime}
              onChange={(e) =>
                onUpdateSlot(dayKey, slotIndex, "startTime", e.target.value)
              }
              className={`col-span-3 ${!slot.isValid ? "border-red-500" : ""}`}
              step="900"
            />
            <span className="text-center">to</span>
            <Input
              type="time"
              value={slot.endTime}
              onChange={(e) =>
                onUpdateSlot(dayKey, slotIndex, "endTime", e.target.value)
              }
              className={`col-span-2 ${!slot.isValid ? "border-red-500" : ""}`}
              step="900"
            />
            <button
              type="button"
              onClick={() => onDeleteSlot(dayKey, slotIndex)}
              className="p-1 hover:bg-zinc-100 rounded"
              aria-label={`Delete slot ${slotIndex + 1} for ${label}`}
            >
              <TrashIcon className="w-5 h-5" />
            </button>
          </div>
          {!slot.isValid && slot.errorMessage && (
            <p className="text-red-500 text-sm">{slot.errorMessage}</p>
          )}
        </div>
      ))}
    </div>
  );
}
