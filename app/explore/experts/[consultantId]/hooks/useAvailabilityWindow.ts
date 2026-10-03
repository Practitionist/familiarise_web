"use client";

import { useQuery } from "@tanstack/react-query";
import { endOfMonth, startOfMonth } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useRef, type MutableRefObject } from "react";
import type { TIntervalTiming } from "@/types/slots";

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
): Promise<AvailabilityWindowData> {
  const consulteeParam = consulteeUserId
    ? `&consulteeUserId=${encodeURIComponent(consulteeUserId)}`
    : "";
  const url = `/api/scheduling/availability-with-allocation/${consultantId}?startDateInUtc=${startUtc.toISOString()}&endDateInUtc=${endUtc.toISOString()}&timezone=${encodeURIComponent(timezone)}${consulteeParam}`;

  const cachedEntry =
    !noStore && etagCacheRef?.current && etagCacheRef.current.key === url
      ? etagCacheRef.current
      : null;

  const init: RequestInit | undefined = noStore
    ? { cache: "no-store" }
    : cachedEntry?.etag
      ? {
          headers: {
            "If-None-Match": cachedEntry.etag,
            "X-Availability-If-None-Match": cachedEntry.etag,
          },
        }
      : undefined;

  const response = await fetch(url, init);
  if (response.status === 304 && cachedEntry) {
    return cachedEntry.data;
  }
  if (!response.ok) {
    const errorData = await response
      .json()
      .catch(() => ({ error: "Failed to fetch availability slots" }));
    throw new Error(errorData.error || "Failed to fetch availability slots");
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

export function availabilityQueryKey(
  consultantId: string,
  startUtc: Date,
  endUtc: Date,
  timezone: string,
  consulteeUserId?: string,
) {
  return consulteeUserId
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
}

/**
 * Shared availability-with-allocation reader.
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
  enabled = true,
  bypassRef,
}: {
  consultantId: string | undefined;
  startUtc: Date | null;
  endUtc: Date | null;
  timezone: string | null;
  consulteeUserId?: string;
  enabled?: boolean;
  bypassRef?: MutableRefObject<boolean>;
}) {
  const etagCacheRef = useRef<EtagCacheEntry | null>(null);
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
      );
    },
    enabled: ready,
    // The grid answer is `private, max-age=30`: re-reading sooner than that
    // can only return the same bytes, so don't. One retry: the endpoint runs
    // the allocation compute, and a cold-start 500 followed by a warm retry
    // is the normal shape on this host.
    staleTime: 30_000,
    retry: 1,
  });
}

/** `yyyy-MM` of a month's first day in the viewer's zone — the month query's key part. */
export function monthKeyOf(monthStart: Date, timezone: string): string {
  return formatInTimeZone(monthStart, timezone, "yyyy-MM");
}

/**
 * One read for the whole visible month (#1785 L-4), so the calendar can ring
 * the days that really have a bookable time rather than the days that merely
 * have hours published — the Cal.com trap (calcom/cal.diy#2329) was a day
 * marked available when every slot on it was taken. The route's window cap
 * is 32 days, which fits any month in one call. `staleTime` 60 s: the month
 * marks may lag the day list by half a minute; the day list stays the truth
 * the checkout re-validates anyway.
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
  const ready = enabled && !!consultantId && !!timezone;
  const monthKey = timezone ? monthKeyOf(monthStart, timezone) : "";
  return useQuery({
    queryKey: ready
      ? consulteeUserId
        ? [
            "availability-month",
            consultantId,
            monthKey,
            timezone,
            consulteeUserId,
          ]
        : ["availability-month", consultantId, monthKey, timezone]
      : ["availability-month", "disabled"],
    queryFn: () =>
      fetchWindow(
        consultantId as string,
        startOfMonth(monthStart),
        endOfMonth(monthStart),
        timezone as string,
        false,
        consulteeUserId,
        etagCacheRef,
      ),
    enabled: ready,
    staleTime: 60_000,
    retry: 1,
  });
}
