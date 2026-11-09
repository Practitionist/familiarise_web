"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  deriveBookingPresentation,
  toneBadge,
} from "@/lib/dashboard/money-state";
import {
  inboxQueryKey,
  inboxQueryString,
  type InboxRowInput,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import { reportSentryError } from "@/lib/observability/report";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatInViewerZone } from "@/lib/time/viewer-zone";

import { KIND_LABEL, NEXT_CYCLE_BADGE, nextCycleLine } from "./labels";
import { requestCountLine } from "./request-count-line";

const PREVIEW_ROWS = 5;

/**
 * The rows Home shows, first five. A checkout the learner is paying for is
 * nobody's request, so it is left out; a row without the field is shown.
 */
export function homePreviewRows<
  T extends { checkoutHold?: InboxRowInput["checkoutHold"] },
>(rows: readonly T[]): T[] {
  return rows.filter((row) => !row.checkoutHold).slice(0, PREVIEW_ROWS);
}

/** The one line under the name: the cycle words for a subscription, else when it was asked. */
function previewLine(row: InboxRowInput, zone: string): string {
  if (row.kind === "next-cycle" && row.entitlement) {
    return nextCycleLine(row.entitlement);
  }
  if (row.kind === "subscription" && row.entitlement) {
    return requestCountLine({ entitlement: row.entitlement });
  }
  return `Requested ${formatInViewerZone(new Date(row.requestedAt), zone, "d MMM, h:mm a")}`;
}

export const REQUESTS_LOAD_ERROR = "Couldn't load requests. Try again.";
export const REQUESTS_FORBIDDEN = "You don't have access to these requests.";

/** A refused or failed inbox read; the status decides whether a retry can help. */
export class RequestsLoadError extends Error {
  constructor(readonly status: number | null) {
    super(`Requests inbox read failed${status ? ` (${status})` : ""}`);
    this.name = "RequestsLoadError";
  }
}

/** A 403 is a permission problem, not a transient fault: retrying cannot fix it. */
export const isForbidden = (error: unknown): boolean =>
  error instanceof RequestsLoadError && error.status === 403;

function isInboxPayload(value: unknown): value is RequestsInboxPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    Array.isArray(value.rows)
  );
}

/**
 * Home's one read of the Requests inbox (consultation tab, priority order,
 * where a new expert's first request lands). The Needs-you list and the
 * Requests panel both draw from it, so it is fetched once per visit. A 403 is
 * reported once and never retried.
 */
export function useHomeRequests(consultantId: string) {
  const queryArgs = {
    consultantProfileId: consultantId,
    scope: "personal",
    type: "consultation" as const,
    chip: null,
    sort: "priority" as const,
    page: 1,
    after: null,
    focus: null,
  };
  const query = useQuery({
    queryKey: inboxQueryKey(queryArgs),
    queryFn: async ({ signal }): Promise<RequestsInboxPayload> => {
      // A stalled cold instance must surface as an error with a Retry, not
      // as skeletons that never leave.
      const response = await fetch(
        `/api/bookings/inbox?${inboxQueryString(queryArgs)}`,
        {
          signal:
            typeof AbortSignal.any === "function"
              ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
              : signal,
        },
      );
      if (!response.ok) throw new RequestsLoadError(response.status);
      const body: unknown = await response.json().catch(() => null);
      if (!isInboxPayload(body)) throw new RequestsLoadError(null);
      return body;
    },
    enabled: consultantId !== "",
    staleTime: 30_000,
    retry: (failureCount, error) => !isForbidden(error) && failureCount < 1,
  });

  const forbiddenError = isForbidden(query.error) ? query.error : null;
  useEffect(() => {
    if (forbiddenError) {
      reportSentryError(forbiddenError, {
        subsystem: "dashboard",
        op: "home-requests",
        expected: true,
      });
    }
  }, [forbiddenError]);

  return query;
}

export type HomeRequestsQuery = ReturnType<typeof useHomeRequests>;

/**
 * Home's Requests panel body: the first five rows of the same read the inbox
 * pages, priority order. Each row opens that request in the inbox.
 */
export function RequestsInboxPreview({
  consultantProfileId,
  query,
}: Readonly<{ consultantProfileId: string; query: HomeRequestsQuery }>) {
  const viewer = useViewerZone();

  // A disabled query never leaves pending; nothing to show without an id.
  if (consultantProfileId === "") return null;
  if (query.isPending) {
    return (
      <div role="status" aria-live="polite" className="space-y-2">
        <span className="sr-only">Loading requests</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    if (isForbidden(query.error)) {
      return <p className="text-sm">{REQUESTS_FORBIDDEN}</p>;
    }
    return (
      <div className="space-y-2 text-sm">
        <p>{REQUESTS_LOAD_ERROR}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  const rows = homePreviewRows(query.data.rows);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No pending requests.</p>
    );
  }
  return (
    <ul className="-mx-2 divide-y divide-border text-sm">
      {rows.map((row) => {
        const { bookingState } = deriveBookingPresentation(
          row.presentation,
          "CONSULTANT",
        );
        const badge =
          row.kind === "next-cycle"
            ? NEXT_CYCLE_BADGE
            : toneBadge(bookingState.tone, bookingState.label);
        return (
          <li key={row.id}>
            <Link
              href={`/dashboard/consultant/${consultantProfileId}/requests?focus=${encodeURIComponent(row.id)}`}
              className="flex items-start justify-between gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">
                  {row.requester.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {KIND_LABEL[row.kind]} · {row.planTitle}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {previewLine(row, viewer.zone)}
                </span>
              </span>
              <StatusBadge {...badge} size="sm" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
