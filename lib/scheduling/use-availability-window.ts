"use client";

import {
  keepPreviousData,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { useRef, useState, type MutableRefObject } from "react";
import type { TIntervalTiming } from "@/types/slots";
import { createGridPollInterval } from "@/lib/scheduling/availabilityPolling";
import { calendarDateKey, dayRangeBounds } from "@/lib/time/grid-zone";
import { byCodeUnit } from "@/lib/scheduling/code-unit-order";

/**
 * One day of the availability-with-allocation grid answer.
 *
 * The endpoint keys days `yyyy-MM-dd` in the requested timezone and returns
 * the slot timings plus the allocation overlay the pricing panel needs.
 */
export type AvailabilityDaySlots = (TIntervalTiming & {
  isAllocated: boolean;
  bookingStatus: "available" | "partially-booked" | "fully-booked";
})[];

export type AvailabilityWindowData = Record<string, AvailabilityDaySlots>;

/** The copy every reader shows when the grid cannot be read; detail goes to the console. */
export const AVAILABILITY_READ_FAILED_MESSAGE =
  "We couldn't load the available times. Check your connection and try again.";

/** A failed grid read. `message` is user copy; the server's own text stays in `detail`. */
export class AvailabilityReadError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, detail: unknown) {
    super(AVAILABILITY_READ_FAILED_MESSAGE);
    this.name = "AvailabilityReadError";
    this.status = status;
    this.detail = detail;
  }
}

export interface EtagCacheEntry {
  key: string;
  etag: string;
  data: AvailabilityWindowData;
}

async function fetchWindow(
  consultantId: string,
  startUtc: Date,
  endUtc: Date,
  timezone: string,
  noStore: boolean,
  consulteeUserId?: string,
  etagCacheRef?: MutableRefObject<EtagCacheEntry | null>,
  subscriptionId?: string,
  releasing?: string,
  eventQuery = "",
): Promise<AvailabilityWindowData> {
  const consulteeParam = consulteeUserId
    ? `&consulteeUserId=${encodeURIComponent(consulteeUserId)}`
    : "";
  const subscriptionParam = subscriptionId
    ? `&subscriptionId=${encodeURIComponent(subscriptionId)}${releasing ? `&releasing=${encodeURIComponent(releasing)}` : ""}`
    : "";
  const url = `/api/scheduling/availability-with-allocation/${consultantId}?startDateInUtc=${startUtc.toISOString()}&endDateInUtc=${endUtc.toISOString()}&timezone=${encodeURIComponent(timezone)}${consulteeParam}${subscriptionParam}${eventQuery}`;

  const cachedEntry =
    !noStore && etagCacheRef?.current?.key === url
      ? etagCacheRef.current
      : null;

  let init: RequestInit;
  if (noStore) {
    init = { credentials: "include", cache: "no-store" };
  } else if (cachedEntry?.etag) {
    init = {
      credentials: "include",
      headers: {
        "If-None-Match": cachedEntry.etag,
        "X-Availability-If-None-Match": cachedEntry.etag,
      },
    };
  } else {
    init = { credentials: "include" };
  }

  let response = await fetch(url, init);
  if (response.status === 304) {
    if (cachedEntry) {
      return cachedEntry.data;
    }
    response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });
  }
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => null);
    console.warn("Availability read failed", response.status, detail);
    throw new AvailabilityReadError(response.status, detail);
  }
  const { data } = await response.json();
  const resolved = (data ?? {}) as AvailabilityWindowData;
  const responseEtag =
    response.headers?.get?.("ETag") ?? response.headers?.get?.("etag") ?? null;
  if (responseEtag && etagCacheRef) {
    etagCacheRef.current = {
      key: url,
      etag: responseEtag,
      data: resolved,
    };
  }
  return resolved;
}

/**
 * Freshness is UX only: checkout's atomic recheck under the slot lock is what keeps a taken time
 * from being sold. Polls only while the tab is visible; 304s keep the cached answer.
 */
function useGridPollOptions() {
  const [interval] = useState(createGridPollInterval);
  return {
    refetchInterval: (query: { state: Parameters<typeof interval>[0] }) =>
      interval(query.state),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  };
}

/** Marks every grid read for this consultant stale, so mounted readers refetch now. */
export function invalidateAvailability(
  queryClient: QueryClient,
  consultantId: string | undefined,
): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["availability", consultantId] }),
    queryClient.invalidateQueries({
      queryKey: ["availability-month", consultantId],
    }),
  ]).then(() => undefined);
}

/** The event a host is placing: co-hosts fold in; a move frees its own sessions. */
export interface AvailabilityEvent {
  classId?: string;
  webinarId?: string;
  moving?: boolean;
}

function eventQueryOf(event: AvailabilityEvent | undefined): string {
  if (event?.classId) {
    return `&classId=${encodeURIComponent(event.classId)}${event.moving ? "&purpose=reschedule" : ""}`;
  }
  if (event?.webinarId) {
    return `&webinarId=${encodeURIComponent(event.webinarId)}${event.moving ? "&purpose=reschedule" : ""}`;
  }
  return "";
}

export function availabilityQueryKey(
  consultantId: string,
  startUtc: Date,
  endUtc: Date,
  timezone: string,
  consulteeUserId?: string,
  subscriptionId?: string,
  releasing?: string,
  eventQuery?: string,
) {
  const base = consulteeUserId
    ? [
        "availability",
        consultantId,
        startUtc.toISOString(),
        endUtc.toISOString(),
        timezone,
        consulteeUserId,
      ]
    : [
        "availability",
        consultantId,
        startUtc.toISOString(),
        endUtc.toISOString(),
        timezone,
      ];
  // The plan-limit overlay and the event change the answer, so they key it too.
  const keyed = subscriptionId
    ? [
        ...base,
        `subscription:${subscriptionId}`,
        `releasing:${releasing ?? ""}`,
      ]
    : base;
  return eventQuery ? [...keyed, `event:${eventQuery}`] : keyed;
}

/**
 * Shared availability-with-allocation reader: the expert page, its booking
 * dialog and the consultee's mobile day list. `timezone` is the display
 * zone the days are keyed in; `consulteeUserId` scopes the overlay to the
 * buyer (their own holds, their plan limits).
 *
 * The pricing panel (1-day slice) and the overview panel (7-day week) used to
 * fetch the same endpoint independently on every mount — two overlapping
 * allocation computes per visit, plus a third when the overview fired with the
 * `"UTC"` fallback before browser-timezone detection landed. One query key
 * per (consultant, window, timezone) means overlapping readers share a single
 * in-flight request, and date clicks inside an already-loaded week cost zero
 * requests (`staleTime` 30s mirrors the endpoint's `private, max-age=30`).
 *
 * `bypassRef` preserves the #1591 conflict flow: set it to `true` to force
 * the next fetch past the browser cache once (back/forward restore after a
 * checkout 409), then it resets itself.
 */
export function useAvailabilityWindow({
  consultantId,
  startUtc,
  endUtc,
  timezone,
  consulteeUserId,
  subscriptionId,
  releasingIds,
  event,
  enabled = true,
  bypassRef,
  keepPrevious = false,
}: {
  consultantId: string | undefined;
  startUtc: Date | null;
  endUtc: Date | null;
  timezone: string | null;
  consulteeUserId?: string;
  /** Adds the plan's weekly/day limit overlay (`limitReached` cells). */
  subscriptionId?: string;
  /** Sessions a reschedule is moving; the overlay counts them as free. */
  releasingIds?: readonly string[];
  /** The event being placed or moved. */
  event?: AvailabilityEvent;
  enabled?: boolean;
  bypassRef?: MutableRefObject<boolean>;
  /** Keep showing the last answer while a new window loads (no skeleton swap). */
  keepPrevious?: boolean;
}) {
  const etagCacheRef = useRef<EtagCacheEntry | null>(null);
  const pollOptions = useGridPollOptions();
  const releasing = releasingIds?.length
    ? [...releasingIds].sort(byCodeUnit).join(",")
    : undefined;
  const eventQuery = eventQueryOf(event);
  const ready =
    enabled && !!consultantId && !!startUtc && !!endUtc && !!timezone;
  return useQuery({
    queryKey:
      ready && consultantId && startUtc && endUtc && timezone
        ? availabilityQueryKey(
            consultantId,
            startUtc,
            endUtc,
            timezone,
            consulteeUserId,
            subscriptionId,
            releasing,
            eventQuery,
          )
        : ["availability", "disabled"],
    queryFn: () => {
      const noStore = bypassRef?.current ?? false;
      if (bypassRef) bypassRef.current = false;
      return fetchWindow(
        consultantId as string,
        startUtc as Date,
        endUtc as Date,
        timezone as string,
        noStore,
        consulteeUserId,
        etagCacheRef,
        subscriptionId,
        releasing,
        eventQuery,
      );
    },
    enabled: ready,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    // The grid answer is `private, max-age=30`: re-reading sooner than that
    // can only return the same bytes, so don't. One retry: the endpoint runs
    // the allocation compute, and a cold-start 500 followed by a warm retry
    // is the normal shape on this host.
    staleTime: 30_000,
    retry: 1,
    ...pollOptions,
  });
}

/** `yyyy-MM` of a calendar month (its local fields) — the month query's key part. */
export function monthKeyOf(monthStart: Date): string {
  return calendarDateKey(monthStart).slice(0, 7);
}

/** The first to last instant of the calendar month `monthStart` names, read in `timezone`. */
export function monthBounds(
  monthStart: Date,
  timezone: string,
): { start: Date; end: Date } {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  return dayRangeBounds(
    new Date(year, month, 1, 12),
    new Date(year, month + 1, 0, 12),
    timezone,
  );
}

/**
 * One read for the whole visible month (#1785 L-4), so the calendar can ring
 * the days that really have a bookable time rather than the days that merely
 * have hours published — the Cal.com trap (calcom/cal.diy#2329) was a day
 * marked available when every slot on it was taken. The route's window cap
 * is 32 days, which fits any month in one call. `staleTime` 60 s: the month
 * marks may lag the day list by half a minute; the day list stays the truth
 * the checkout re-validates anyway. `monthStart` is a calendar date; the
 * window is that month's first to last day in `timezone`, so the 1st and the
 * last day keep every one of their atoms whatever the device's own zone.
 */
export function useAvailabilityMonth({
  consultantId,
  monthStart,
  timezone,
  consulteeUserId,
  enabled = true,
}: {
  consultantId: string | undefined;
  monthStart: Date;
  timezone: string | null;
  consulteeUserId?: string;
  enabled?: boolean;
}) {
  const etagCacheRef = useRef<EtagCacheEntry | null>(null);
  const pollOptions = useGridPollOptions();
  const ready = enabled && !!consultantId && !!timezone;
  const monthKey = monthKeyOf(monthStart);
  const queryKey = consulteeUserId
    ? ["availability-month", consultantId, monthKey, timezone, consulteeUserId]
    : ["availability-month", consultantId, monthKey, timezone];
  const activeQueryKey = ready ? queryKey : ["availability-month", "disabled"];
  return useQuery({
    queryKey: activeQueryKey,
    queryFn: () => {
      const zone = timezone as string;
      const { start, end } = monthBounds(monthStart, zone);
      return fetchWindow(
        consultantId as string,
        start,
        end,
        zone,
        false,
        consulteeUserId,
        etagCacheRef,
      );
    },
    enabled: ready,
    staleTime: 60_000,
    retry: 1,
    ...pollOptions,
  });
}
