"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";

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
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatInViewerZone } from "@/lib/time/viewer-zone";

import {
  KIND_LABEL,
  NEXT_CYCLE_BADGE,
  errorSentence,
  nextCycleLine,
} from "./labels";
import { requestCountLine } from "./request-count-line";

const PREVIEW_ROWS = 5;

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

/**
 * Home's "Pending requests" card: the first five rows of the SAME read the
 * inbox pages (#1775 A-6), priority order, no actions — "View all" is the
 * action. Reads the consultation tab, which is where a new consultant's
 * first request lands.
 */
export function RequestsInboxPreview({
  consultantProfileId,
}: Readonly<{ consultantProfileId?: string }>) {
  const params = useParams<{ consultantId: string }>();
  const consultantId = consultantProfileId ?? params?.consultantId ?? "";
  const viewer = useViewerZone();
  const queryArgs = {
    consultantProfileId: consultantId,
    scope: "personal",
    type: "consultation" as const,
    chip: null,
    sort: "priority" as const,
    page: 1,
  };
  const query = useQuery({
    queryKey: inboxQueryKey(queryArgs),
    queryFn: async ({ signal }): Promise<RequestsInboxPayload> => {
      // A stalled cold instance must surface as an error with a Retry, not
      // as skeletons that never leave (QA #1783 case 9).
      const response = await fetch(
        `/api/bookings/inbox?${inboxQueryString(queryArgs)}`,
        {
          signal:
            typeof AbortSignal.any === "function"
              ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
              : signal,
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (!response.ok) {
        throw new Error(
          errorSentence(body.code, body.error ?? "Could not load"),
        );
      }
      return body as unknown as RequestsInboxPayload;
    },
    enabled: consultantId !== "",
    staleTime: 30_000,
    retry: 1,
  });

  // A disabled query never leaves pending; nothing to show without an id.
  if (consultantId === "") return null;
  if (query.isPending) {
    return (
      <div role="status" aria-live="polite" className="space-y-2 p-2">
        <span className="sr-only">Loading requests</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-2 p-4 text-sm">
        <p className="text-destructive">
          {query.error instanceof Error && query.error.name !== "TimeoutError"
            ? query.error.message
            : "Requests took too long to load."}
        </p>
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
  const rows = query.data.rows.slice(0, PREVIEW_ROWS);
  if (rows.length === 0) {
    return (
      <p className="p-4 text-center text-sm text-muted-foreground">
        No pending requests
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border text-sm">
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
          <li
            key={row.id}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">
                {row.requester.name}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {KIND_LABEL[row.kind]} · {row.planTitle}
                </span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {previewLine(row, viewer.zone)}
              </p>
            </div>
            <Link
              href={`/dashboard/consultant/${consultantId}/requests?type=${row.kind === "next-cycle" ? "subscription" : row.kind}`}
              className="shrink-0"
            >
              <StatusBadge {...badge} size="sm" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
