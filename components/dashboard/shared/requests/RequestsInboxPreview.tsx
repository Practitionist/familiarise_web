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
  parseRequestsInboxPayload,
  sortInboxRows,
  type InboxRowInput,
  type InboxType,
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

/**
 * The rows Home shows, first five. A checkout the learner is paying for is
 * nobody's request, so it is left out; a row without the field is shown.
 */
export function homePreviewRows<
  T extends { checkoutHold?: InboxRowInput["checkoutHold"] },
>(rows: readonly T[]): T[] {
  return rows.filter((row) => !row.checkoutHold).slice(0, PREVIEW_ROWS);
}

/** The expert's own open proposal waits on the client; null for any other row. */
export function ownMoveWaitingLine(row: {
  requester: { name: string };
  proposal: { status: string; initiatorRole: string } | null;
}): string | null {
  return row.proposal?.status === "PENDING_REVIEW" &&
    row.proposal.initiatorRole === "CONSULTANT"
    ? `You proposed a new time · waiting on ${row.requester.name}`
    : null;
}

/** The one line under the name: the cycle words for a subscription, else when it was asked. */
function previewLine(row: InboxRowInput, zone: string): string {
  const ownMove = ownMoveWaitingLine(row);
  if (ownMove) return ownMove;
  if (row.kind === "next-cycle" && row.entitlement) {
    return nextCycleLine(row.entitlement);
  }
  if (row.kind === "subscription" && row.entitlement) {
    return requestCountLine({ entitlement: row.entitlement });
  }
  return `Requested ${formatInViewerZone(new Date(row.requestedAt), zone, "d MMM, h:mm a")}`;
}

function previewQueryArgs(consultantProfileId: string, type: InboxType) {
  return {
    consultantProfileId,
    scope: "personal",
    type,
    chip: null,
    sort: "priority" as const,
    page: 1,
    after: null,
    focus: null,
  };
}

async function fetchPreviewTab(
  args: ReturnType<typeof previewQueryArgs>,
  signal: AbortSignal,
): Promise<RequestsInboxPayload> {
  // A stalled cold instance must surface as an error with a Retry, not
  // as skeletons that never leave.
  const response = await fetch(
    `/api/bookings/inbox?${inboxQueryString(args)}`,
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
    throw new Error(errorSentence(body.code, body.error ?? "Could not load"));
  }
  return parseRequestsInboxPayload(body);
}

/**
 * Home's "Pending requests" card: the first five rows the Requests page lists,
 * priority order, no actions ("View all" is the action). The subscription tab
 * is read when the inbox counts rows on it, so a paid plan waiting for times
 * is listed here as Home's "requests" count includes it.
 */
export function RequestsInboxPreview({
  consultantProfileId,
}: Readonly<{ consultantProfileId?: string }>) {
  const params = useParams<{ consultantId: string }>();
  const consultantId = consultantProfileId ?? params?.consultantId ?? "";
  const viewer = useViewerZone();
  const consultationArgs = previewQueryArgs(consultantId, "consultation");
  const subscriptionArgs = previewQueryArgs(consultantId, "subscription");
  const query = useQuery({
    queryKey: inboxQueryKey(consultationArgs),
    queryFn: ({ signal }) => fetchPreviewTab(consultationArgs, signal),
    enabled: consultantId !== "",
    staleTime: 30_000,
    retry: 1,
  });
  const readsSubscriptions = (query.data?.meta.counts.subscription ?? 0) > 0;
  const subscriptions = useQuery({
    queryKey: inboxQueryKey(subscriptionArgs),
    queryFn: ({ signal }) => fetchPreviewTab(subscriptionArgs, signal),
    enabled: readsSubscriptions,
    staleTime: 30_000,
    retry: 1,
  });

  // A disabled query never leaves pending; nothing to show without an id.
  if (consultantId === "") return null;
  const reads = readsSubscriptions ? [query, subscriptions] : [query];
  if (reads.some((read) => read.isPending)) {
    return (
      <div role="status" aria-live="polite" className="space-y-2 p-2">
        <span className="sr-only">Loading requests</span>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  const failed = reads.find((read) => read.isError);
  if (failed) {
    return (
      <div className="space-y-2 p-4 text-sm">
        <p className="text-destructive">
          {failed.error instanceof Error && failed.error.name !== "TimeoutError"
            ? failed.error.message
            : "Requests took too long to load."}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            for (const read of reads) void read.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  const rows = homePreviewRows(
    sortInboxRows(
      reads.flatMap((read) => read.data?.rows ?? []),
      "priority",
    ),
  );
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
          { viewerZone: viewer.zone },
        );
        let badge = toneBadge(bookingState.tone, bookingState.label);
        if (row.kind === "next-cycle") badge = NEXT_CYCLE_BADGE;
        else if (ownMoveWaitingLine(row)) {
          badge = toneBadge("info", "Waiting on client");
        }
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
