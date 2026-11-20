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
  isRequestToAnswer,
  parseRequestsInboxPayload,
  sortInboxRows,
  type InboxRowInput,
  type InboxType,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatInViewerZone } from "@/lib/time/viewer-zone";

import { KIND_LABEL, errorSentence } from "./labels";
import { requestCountLine } from "./request-count-line";

const PREVIEW_ROWS = 5;

/**
 * The rows Home shows, first five: the ones Home's count holds, so a pay link
 * or a checkout waiting on the learner is left to the Requests page.
 */
export function homePreviewRows<
  T extends Parameters<typeof isRequestToAnswer>[0],
>(rows: readonly T[]): T[] {
  return rows.filter(isRequestToAnswer).slice(0, PREVIEW_ROWS);
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
 * Home's Requests card: the first five requests to answer, priority order, no
 * actions ("Open Requests" is the action). The subscription tab is read when
 * the inbox counts rows on it, so a paid plan waiting for times is listed.
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
        No requests to answer
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
        const badge = ownMoveWaitingLine(row)
          ? toneBadge("info", "Waiting on client")
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
              href={`/dashboard/consultant/${consultantId}/requests?type=${row.kind}`}
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
