"use client";

import { useQuery } from "@tanstack/react-query";
import type { MutableRefObject } from "react";
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

async function fetchWindow(
  consultantId: string,
  startUtc: Date,
  endUtc: Date,
  timezone: string,
  noStore: boolean,
): Promise<AvailabilityWindowData> {
  const response = await fetch(
    `/api/scheduling/availability-with-allocation/${consultantId}?startDateInUtc=${startUtc.toISOString()}&endDateInUtc=${endUtc.toISOString()}&timezone=${encodeURIComponent(timezone)}`,
    noStore ? { cache: "no-store" } : undefined,
  );
  if (!response.ok) {
    const errorData = await response
      .json()
      .catch(() => ({ error: "Failed to fetch availability slots" }));
    throw new Error(errorData.error || "Failed to fetch availability slots");
  }
  const { data } = await response.json();
  return (data ?? {}) as AvailabilityWindowData;
}

export function availabilityQueryKey(
  consultantId: string,
  startUtc: Date,
  endUtc: Date,
  timezone: string,
) {
  return [
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
  enabled = true,
  bypassRef,
}: {
  consultantId: string | undefined;
  startUtc: Date | null;
  endUtc: Date | null;
  timezone: string | null;
  enabled?: boolean;
  bypassRef?: MutableRefObject<boolean>;
}) {
  const ready =
    enabled && !!consultantId && !!startUtc && !!endUtc && !!timezone;
  return useQuery({
    queryKey:
      ready && consultantId && startUtc && endUtc && timezone
        ? availabilityQueryKey(consultantId, startUtc, endUtc, timezone)
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
