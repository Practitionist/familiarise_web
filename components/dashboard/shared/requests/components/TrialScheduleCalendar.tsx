"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Calendar, Clock, Loader2 } from "lucide-react";
import { differenceInCalendarDays } from "date-fns";

import { SlotStatusIcon } from "@/components/scheduling/SlotStatusIcon";
import { SlotStatusLegend } from "@/components/scheduling/SlotStatusLegend";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import { Button } from "@/components/ui/button";
import { useNowTick } from "@/hooks/use-now-tick";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import {
  BUYER_LEGEND_KEYS,
  SLOT_STATUS_TOKENS,
  type SlotStatusKey,
} from "@/lib/scheduling/interval-status-tokens";
import {
  calendarDateKey,
  calendarDayOf,
  dayRangeBounds,
} from "@/lib/time/grid-zone";
import {
  sameWindow,
  windowsForDay,
  type SlotWithStatus,
} from "@/lib/scheduling/booking-windows";
import { AvailabilityReadError } from "@/lib/scheduling/use-availability-window";
import { leadMsFor, type LeadPurpose } from "@/lib/booking/lead-time";
import { useDisplayZone } from "@/lib/time/use-display-zone";
import { cn } from "@/utils/tailwind";

export interface SelectedSlot {
  startsAt: Date;
  endsAt: Date;
  availabilityWindowId: string;
  slotType: "WEEKLY" | "CUSTOM";
}

const atomSchema = z.object({
  slotId: z.string().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  availabilityWindowId: z.string(),
  type: z.enum(["WEEKLY", "CUSTOM"]),
  localStartTime: z.string().optional(),
  localEndTime: z.string().optional(),
  isAllocated: z.boolean().optional(),
  bookingStatus: z
    .enum(["available", "partially-booked", "fully-booked"])
    .optional(),
  tooSoon: z.boolean().optional(),
  limitReached: z.boolean().optional(),
});
const gridAnswerSchema = z.object({
  data: z.record(z.string(), z.array(atomSchema)).nullish(),
});
type GridAtom = z.infer<typeof atomSchema>;

/**
 * How a trial time paints, or `null` when it is already over (not listed).
 * Only "available" can be picked; a contended time is never offered here.
 */
export function trialTimeStatus(
  window: SlotWithStatus,
  nowMs: number,
): SlotStatusKey | null {
  if (new Date(window.startsAt).getTime() < nowMs) return null;
  if (window.bookingStatus === "fully-booked") return "fullyBooked";
  if (window.bookingStatus === "partially-booked") return "partiallyBooked";
  if (window.isAllocated) return "fullyBooked";
  if (window.tooSoon || window._isPast) return "tooSoon";
  if (window.limitReached) return "limitReached";
  return "available";
}

type DayRead =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; atoms: GridAtom[] };

interface TrialScheduleCalendarProps {
  consultantId: string;
  trialDurationMinutes: number;
  onSlotSelect: (slot: SelectedSlot) => void;
  onCancel: () => void;
  isProcessing?: boolean;
  consulteeUserName?: string;
  /** The trial's consultee, so their busy times are greyed out too. */
  consulteeUserId?: string;
  /** Which writer the pick goes to; it sets the lead time the times honour. */
  purpose?: LeadPurpose;
  heading?: string;
  confirmLabel?: string;
}

export function TrialScheduleCalendar({
  consultantId,
  trialDurationMinutes,
  onSlotSelect,
  onCancel,
  isProcessing = false,
  consulteeUserName,
  consulteeUserId,
  purpose = "allocate",
  heading = "Schedule Trial",
  confirmLabel = "Confirm Schedule",
}: Readonly<TrialScheduleCalendarProps>) {
  // The trial is free or already paid when its time is placed or moved.
  const leadMs = leadMsFor(purpose, { settled: true });
  const { toast } = useToast();
  const { data: session, isPending: isSessionPending } = useSession();
  const displayZone = useDisplayZone(session?.user?.timezone ?? null);
  const zone = displayZone.zone;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const zoneReady = mounted && !isSessionPending;

  const now = useNowTick(60_000);
  const today = calendarDayOf(now, zone);
  // Calendar dates (local fields only); null means "today in the zone".
  const [pickedDate, setPickedDate] = useState<Date | null>(null);
  const [viewMonth, setViewMonth] = useState<Date | null>(null);
  const selectedDate = pickedDate ?? today;
  const shownMonth =
    viewMonth ?? new Date(today.getFullYear(), today.getMonth(), 1, 12);
  const selectedKey = calendarDateKey(selectedDate);

  const [selectedSlot, setSelectedSlot] = useState<SlotWithStatus | null>(null);
  const [read, setRead] = useState<DayRead>({ state: "loading" });
  const [retryCount, setRetryCount] = useState(0);
  // Only the newest date's answer may land: a slower answer for a date the
  // user already left must not overwrite the one now on screen.
  const latestRequestRef = useRef(0);

  useEffect(() => {
    if (!zoneReady || !consultantId) return;
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    const controller = new AbortController();
    const [year, month, day] = selectedKey.split("-").map(Number);
    const calendarDay = new Date(year, month - 1, day, 12);
    const { start, end } = dayRangeBounds(calendarDay, calendarDay, zone);
    setRead({ state: "loading" });

    const url =
      `/api/scheduling/availability-with-allocation/${consultantId}` +
      `?startDateInUtc=${start.toISOString()}` +
      `&endDateInUtc=${end.toISOString()}` +
      `&timezone=${encodeURIComponent(zone)}` +
      `&purpose=${purpose}` +
      (consulteeUserId
        ? `&consulteeUserId=${encodeURIComponent(consulteeUserId)}`
        : "");
    fetch(url, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const detail: unknown = await response.json().catch(() => null);
          throw new AvailabilityReadError(response.status, detail);
        }
        return gridAnswerSchema.parse(await response.json());
      })
      .then((answer) => {
        if (latestRequestRef.current !== requestId) return;
        setRead({ state: "ready", atoms: answer.data?.[selectedKey] ?? [] });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (latestRequestRef.current !== requestId) return;
        console.warn("Trial picker availability read failed", error);
        setRead({ state: "error" });
      });
    return () => controller.abort();
  }, [
    zoneReady,
    consultantId,
    selectedKey,
    zone,
    retryCount,
    purpose,
    consulteeUserId,
  ]);

  const times = useMemo(() => {
    if (read.state !== "ready") return [];
    return windowsForDay(
      read.atoms,
      trialDurationMinutes / 60,
      zone,
      now.getTime(),
      leadMs,
    ).flatMap((window) => {
      const status = trialTimeStatus(window, now.getTime());
      return status === null ? [] : [{ window, status }];
    });
  }, [read, trialDurationMinutes, zone, now, leadMs]);

  // The confirm button acts only on a pick the latest read still offers.
  const liveSelection =
    selectedSlot === null
      ? null
      : (times.find(
          ({ window, status }) =>
            status === "available" && sameWindow(window, selectedSlot),
        )?.window ?? null);

  const pickDate = (date: Date) => {
    setPickedDate(date);
    setSelectedSlot(null);
  };
  const shiftMonth = (delta: number) =>
    setViewMonth(
      new Date(shownMonth.getFullYear(), shownMonth.getMonth() + delta, 1, 12),
    );

  const renderCalendar = () => {
    const daysInMonth = new Date(
      shownMonth.getFullYear(),
      shownMonth.getMonth() + 1,
      0,
    ).getDate();
    const firstDayOfMonth = new Date(
      shownMonth.getFullYear(),
      shownMonth.getMonth(),
      1,
    ).getDay();
    const adjustedFirstDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
    const todayKey = calendarDateKey(today);
    const cells = [];

    for (let i = 0; i < adjustedFirstDay; i++) {
      cells.push(
        <div key={`empty-${i}`} className="w-10 h-10 lg:w-11 lg:h-11" />,
      );
    }

    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(
        shownMonth.getFullYear(),
        shownMonth.getMonth(),
        i,
        12,
      );
      const key = calendarDateKey(date);
      const isSelected = key === selectedKey;
      const isPast = key < todayKey;

      cells.push(
        <button
          key={key}
          type="button"
          disabled={isPast}
          aria-pressed={isSelected}
          aria-label={date.toLocaleDateString(undefined, {
            day: "numeric",
            month: "long",
          })}
          className={cn(
            "w-10 h-10 lg:w-11 lg:h-11 rounded-full text-base font-medium transition-all duration-200 flex items-center justify-center",
            isSelected
              ? "bg-gray-900 text-white shadow-md"
              : isPast
                ? "text-gray-300 cursor-not-allowed"
                : "text-gray-700 hover:bg-gray-100",
          )}
          onClick={() => pickDate(date)}
        >
          {i}
        </button>,
      );
    }

    return cells;
  };

  const handleConfirm = () => {
    if (!liveSelection) {
      toast({ title: "Pick a time first", variant: "destructive" });
      return;
    }
    onSlotSelect({
      startsAt: new Date(liveSelection.startsAt),
      endsAt: new Date(liveSelection.endsAt),
      availabilityWindowId: liveSelection.availabilityWindowId,
      slotType: liveSelection.type,
    });
  };

  const canGoBack = differenceInCalendarDays(shownMonth, today) > 0;

  return (
    <div className="space-y-6">
      <div className="border-b border-gray-200 pb-4">
        <h2 className="text-xl font-semibold text-gray-900">{heading}</h2>
        <p className="text-sm text-gray-500 mt-1">
          {consulteeUserName
            ? `Pick a ${trialDurationMinutes}-minute time for the trial with ${consulteeUserName}`
            : `Pick a ${trialDurationMinutes}-minute time for the trial`}
        </p>
        <ZoneSwitch
          zone={zone}
          usingDeviceZone={displayZone.usingDeviceZone}
          canSwitch={displayZone.canSwitch}
          onToggle={() => {
            displayZone.toggle();
            setSelectedSlot(null);
          }}
          now={now}
          className="mt-2"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
        <div>
          <h3 className="text-base font-medium mb-4 flex items-center text-gray-900">
            <Calendar className="mr-2 h-5 w-5 text-gray-500" />
            Select a Date
          </h3>
          <div className="bg-gray-50 p-4 lg:p-5 rounded-xl border border-gray-200">
            <div className="flex justify-between items-center mb-4">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Previous month"
                disabled={!canGoBack}
                className="text-gray-600 hover:text-gray-900 hover:bg-gray-100 h-9 w-9"
                onClick={() => shiftMonth(-1)}
              >
                &lt;
              </Button>
              <span className="font-semibold text-gray-900">
                {shownMonth.toLocaleString("default", {
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Next month"
                className="text-gray-600 hover:text-gray-900 hover:bg-gray-100 h-9 w-9"
                onClick={() => shiftMonth(1)}
              >
                &gt;
              </Button>
            </div>

            <div className="grid grid-cols-7 gap-2 text-center text-sm font-medium text-gray-500 mb-2">
              <div>Mo</div>
              <div>Tu</div>
              <div>We</div>
              <div>Th</div>
              <div>Fr</div>
              <div>Sa</div>
              <div>Su</div>
            </div>

            <div className="grid grid-cols-7 gap-1">{renderCalendar()}</div>
          </div>
        </div>

        <div>
          <h3 className="text-base font-medium mb-4 flex items-center text-gray-900">
            <Clock className="mr-2 h-5 w-5 text-gray-500" />
            Available {trialDurationMinutes}-minute times
          </h3>

          <div
            className="bg-gray-50 p-4 rounded-xl border border-gray-200 min-h-[280px] max-h-[350px] overflow-y-auto"
            aria-busy={read.state === "loading"}
          >
            {read.state === "loading" ? (
              <div className="flex items-center justify-center h-full py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                <span className="ml-2 text-gray-500">Loading times…</span>
              </div>
            ) : read.state === "error" ? (
              <div
                role="alert"
                className="flex flex-col items-center justify-center h-full py-8 text-center"
              >
                <p className="text-gray-700 text-sm">
                  We couldn&apos;t load the times for this day.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setRetryCount((count) => count + 1)}
                >
                  Try again
                </Button>
              </div>
            ) : times.length > 0 ? (
              <>
                <div className="space-y-2">
                  {times.map(({ window, status }) => {
                    const isSelected =
                      liveSelection !== null &&
                      sameWindow(window, liveSelection);
                    const paint: SlotStatusKey = isSelected
                      ? "selected"
                      : status;
                    const token = SLOT_STATUS_TOKENS[paint];
                    const selectable = status === "available";
                    return (
                      <button
                        key={window.startsAt}
                        type="button"
                        disabled={!selectable}
                        aria-pressed={selectable ? isSelected : undefined}
                        aria-label={`${window.localStartTime} to ${window.localEndTime}, ${token.label}`}
                        data-status={paint}
                        className={cn(
                          "w-full p-3 text-sm font-medium transition-colors duration-150 rounded-lg text-left border",
                          token.className,
                          selectable ? "cursor-pointer" : "cursor-not-allowed",
                        )}
                        onClick={() => setSelectedSlot(window)}
                      >
                        <span className="flex items-center justify-between w-full">
                          <span className="flex items-center">
                            <Clock
                              aria-hidden="true"
                              className="mr-2 h-4 w-4 opacity-70"
                            />
                            {window.localStartTime} - {window.localEndTime}
                          </span>
                          <span className="flex items-center gap-1 text-xs">
                            {paint !== "available" && token.label}
                            <SlotStatusIcon name={token.icon} />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <SlotStatusLegend
                  keys={BUYER_LEGEND_KEYS}
                  className="mt-4 pt-4 border-t border-gray-200 bg-gray-50"
                />
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full py-8 text-center">
                <Clock className="h-10 w-10 text-gray-300 mb-3" />
                <p className="text-gray-500 text-sm">
                  No free times on this day.
                </p>
                <p className="text-gray-400 text-xs mt-1">Try another date.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-gray-100 border border-gray-300 rounded-lg p-3">
        <p className="text-sm text-gray-800">
          <span className="font-medium">Duration:</span> {trialDurationMinutes}{" "}
          minutes
        </p>
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t border-gray-200">
        <Button variant="outline" onClick={onCancel} disabled={isProcessing}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={!liveSelection || isProcessing}
          className="bg-gray-900 hover:bg-gray-800 text-white"
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Scheduling...
            </>
          ) : (
            confirmLabel
          )}
        </Button>
      </div>
    </div>
  );
}
