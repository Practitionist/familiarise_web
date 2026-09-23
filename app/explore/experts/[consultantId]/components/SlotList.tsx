"use client";

import type { BookingMode } from "@prisma/client";
import { ClockIcon } from "lucide-react";
import { cn } from "@/utils/tailwind";
import {
  partitionSlotsForList,
  slotNeedsRequest,
  takenTimesLine,
  type SlotWithStatus,
} from "./slot-list-policy";

interface SlotListProps {
  slots: readonly SlotWithStatus[];
  selectedSlot: SlotWithStatus | null;
  onSelect: (slot: SlotWithStatus) => void;
  bookingMode: BookingMode;
  acceptingRequests: boolean;
}

/**
 * Semantic color matches the date marks: emerald can be booked now, amber
 * needs approval, and the selected time remains white. Text labels carry the
 * same meaning without relying on color. Taken and past times are not shown.
 */
export function SlotList({
  slots,
  selectedSlot,
  onSelect,
  bookingMode,
  acceptingRequests,
}: Readonly<SlotListProps>) {
  const { bookable, takenCount } = partitionSlotsForList(slots);
  const takenLine = takenTimesLine(takenCount);

  if (bookable.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-zinc-500">
        {takenLine
          ? `${takenLine}. Pick another day.`
          : "No available slots for the selected date."}
      </p>
    );
  }

  return (
    <>
      {bookable.map((slot) => {
        const isSelected =
          selectedSlot?.slotId === slot.slotId &&
          selectedSlot?.localStartTime === slot.localStartTime;
        const needsRequest = slotNeedsRequest(bookingMode, slot);
        const requestPaused = needsRequest && !acceptingRequests;
        return (
          <button
            key={`${slot.slotId}-${slot.localStartTime}`}
            type="button"
            aria-pressed={isSelected}
            disabled={requestPaused}
            className={cn(
              "w-full rounded-xl border p-4 text-left text-base font-medium transition-all duration-200",
              requestPaused &&
                "cursor-not-allowed border-white/[0.08] bg-zinc-800/30 text-zinc-500",
              !requestPaused &&
                isSelected &&
                "border-white bg-white text-zinc-900 shadow-md ring-2",
              !requestPaused &&
                isSelected &&
                (needsRequest ? "ring-amber-400" : "ring-emerald-400"),
              !requestPaused &&
                !isSelected &&
                (needsRequest
                  ? "border-amber-400/40 bg-amber-400/[0.08] text-amber-100 hover:bg-amber-400/[0.15]"
                  : "border-emerald-400/40 bg-emerald-400/[0.08] text-emerald-100 hover:bg-emerald-400/[0.15]"),
            )}
            onClick={() => onSelect(slot)}
          >
            <span className="flex items-center gap-3">
              <ClockIcon className="h-5 w-5 opacity-70" aria-hidden="true" />
              <span className="flex-1">
                {slot.localStartTime} - {slot.localEndTime}
              </span>
              <span
                className={cn(
                  "rounded-md border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                  requestPaused && "border-zinc-600 text-zinc-500",
                  !requestPaused &&
                    isSelected &&
                    (needsRequest
                      ? "border-amber-600/30 text-amber-800"
                      : "border-emerald-600/30 text-emerald-800"),
                  !requestPaused &&
                    !isSelected &&
                    (needsRequest
                      ? "border-amber-400/40 text-amber-200"
                      : "border-emerald-400/40 text-emerald-200"),
                )}
              >
                {requestPaused
                  ? "Requests paused"
                  : needsRequest
                    ? "Request"
                    : "Book now"}
              </span>
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
