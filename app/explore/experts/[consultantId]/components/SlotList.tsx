"use client";

import type { BookingMode } from "@prisma/client";
import { ClockIcon } from "lucide-react";
import { SLOT_STATUS_TOKENS } from "@/lib/scheduling/interval-status-tokens";
import { cn } from "@/utils/tailwind";
import {
  sameWindow,
  type SlotWithStatus,
} from "@/lib/scheduling/booking-windows";
import {
  partitionSlotsForList,
  slotNeedsRequest,
  takenTimesLine,
} from "./slot-list-policy";

interface SlotListProps {
  slots: readonly SlotWithStatus[];
  selectedSlot: SlotWithStatus | null;
  onSelect: (slot: SlotWithStatus) => void;
  bookingMode: BookingMode;
  /** The pick the latest read took away, shown struck through for one render. */
  justTaken?: SlotWithStatus | null;
}

const JUST_TAKEN = SLOT_STATUS_TOKENS.justTaken;

/**
 * The booking dialog's list of times (#1785 L-3), in the quiet-monochrome
 * system: every bookable time is the same neutral pill, the selected one is
 * filled white, and a time the expert must confirm carries a "Request" tag
 * instead of a colour. Taken and past times are not rendered, except the
 * buyer's own pick in the one render it is shown "Just taken".
 */
export function SlotList({
  slots,
  selectedSlot,
  onSelect,
  bookingMode,
  justTaken = null,
}: Readonly<SlotListProps>) {
  const { bookable, takenCount } = partitionSlotsForList(slots);
  const takenLine = takenTimesLine(takenCount);
  const rows = justTaken
    ? [...bookable.filter((slot) => !sameWindow(slot, justTaken)), justTaken]
        .slice()
        .sort(
          (a, b) =>
            new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
        )
    : bookable;

  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-zinc-500">
        {takenLine
          ? `${takenLine}. Pick another day.`
          : "No times are free on this day. Pick another day."}
      </p>
    );
  }

  return (
    <>
      {rows.map((slot) => {
        if (justTaken && slot === justTaken) {
          return (
            <div
              key={`just-taken-${slot.startsAt}`}
              aria-label={`${slot.localStartTime} to ${slot.localEndTime}, just taken`}
              data-just-taken="true"
              className={cn(
                "w-full rounded-xl border p-4 text-left text-base font-medium",
                JUST_TAKEN.className,
              )}
            >
              <span className="flex items-center gap-3">
                <ClockIcon className="h-5 w-5 opacity-70" aria-hidden="true" />
                <span className="flex-1">
                  {slot.localStartTime} - {slot.localEndTime}
                </span>
                <span className="text-[11px] font-medium uppercase tracking-wide no-underline">
                  {JUST_TAKEN.label}
                </span>
              </span>
            </div>
          );
        }
        const isSelected =
          selectedSlot !== null && sameWindow(selectedSlot, slot);
        const needsRequest = slotNeedsRequest(bookingMode, slot);
        return (
          <button
            key={`${slot.slotId}-${slot.localStartTime}`}
            type="button"
            aria-pressed={isSelected}
            className={cn(
              "w-full rounded-xl border p-4 text-left text-base font-medium transition-all duration-200",
              isSelected
                ? "border-white bg-white text-zinc-900 shadow-md ring-2 ring-white"
                : "border-white/[0.12] bg-transparent text-zinc-200 hover:bg-white/[0.06]",
            )}
            onClick={() => onSelect(slot)}
          >
            <span className="flex items-center gap-3">
              <ClockIcon className="h-5 w-5 opacity-70" aria-hidden="true" />
              <span className="flex-1">
                {slot.localStartTime} - {slot.localEndTime}
              </span>
              {needsRequest && (
                <span
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                    isSelected
                      ? "border-zinc-300 text-zinc-600"
                      : "border-white/[0.16] text-zinc-400",
                  )}
                >
                  Request
                </span>
              )}
            </span>
          </button>
        );
      })}
      {takenLine && (
        <p className="pt-1 text-xs text-zinc-500" aria-live="polite">
          {takenLine}
        </p>
      )}
    </>
  );
}
