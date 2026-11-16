"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
  type TableSort,
} from "@/components/ui/responsive-table";
import {
  NEEDS_HUMAN_DEFAULT_SORT,
  NEEDS_HUMAN_PAGE_SIZE,
  NEEDS_HUMAN_SORT_KEYS,
  needsHumanQueueSearch,
  type NeedsHumanItem,
  type NeedsHumanPage,
  type NeedsHumanSort,
} from "@/lib/backoffice/needs-human-queue";
import { SESSION_OUTCOME_LABEL } from "@/lib/labels/session-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { operatorEndKind } from "@/lib/time/operator-zone";
import { humanizeEnum } from "@/lib/ui/tone";
import { SetOutcomeDialog } from "./SetOutcomeDialog";

function whyParked(s: NeedsHumanItem): string {
  if (s.endedReason === "maintenance") return "Cut by maintenance";
  return s.outcome ? SESSION_OUTCOME_LABEL[s.outcome] : "Not decided";
}

/** A header click names a column; only the whitelisted ones become a sort. */
function toQueueSort(sort: TableSort): NeedsHumanSort | null {
  const key = NEEDS_HUMAN_SORT_KEYS.find((k) => k === sort.key);
  return key ? { key, dir: sort.dir } : null;
}

const QUEUE_KEY = ["sessions-needs-human"] as const;

const columns: ResponsiveColumn<NeedsHumanItem>[] = [
  {
    key: "booking",
    header: "Booking",
    primary: true,
    cell: (s) => (
      <div className="min-w-0">
        <p className="truncate font-medium">{s.booking.title || "Booking"}</p>
        <p className="text-xs text-muted-foreground">
          {humanizeEnum(s.booking.type)}
          {s.booking.removed ? " · Removed" : ""}
        </p>
      </div>
    ),
  },
  {
    key: "expert",
    header: "Expert",
    cell: (s) => <PersonCell person={s.booking.expert} />,
  },
  {
    key: "learner",
    header: "Learner",
    cell: (s) =>
      s.booking.attendeeLabel ? (
        <span className="text-sm">{s.booking.attendeeLabel}</span>
      ) : (
        <PersonCell person={s.booking.learner} />
      ),
  },
  {
    key: "startsAt",
    header: "Session",
    sortable: true,
    cell: (s) => <OperatorTime value={s.startsAt} />,
  },
  {
    key: "endsAt",
    header: "Ended",
    sortable: true,
    cell: (s) => (
      <OperatorTime
        value={s.endsAt}
        kind={operatorEndKind(s.startsAt, s.endsAt)}
      />
    ),
  },
  {
    key: "outcomeAt",
    header: "Waiting since",
    sortable: true,
    cell: (s) => (
      <div className="space-y-1">
        <OperatorTime value={s.outcomeAt ?? s.endsAt} />
        {s.aged && (
          <StatusBadge label="Over 7 days; settlement on hold" tone="warning" />
        )}
      </div>
    ),
  },
  { key: "outcome", header: "Outcome", cell: whyParked },
  {
    key: "lostMinutes",
    header: "Lost",
    sortable: true,
    cell: (s) => (s.lostMinutes ? `${s.lostMinutes} min` : "—"),
  },
];

/**
 * Sessions the outcome sweep could not decide, a page at a time, and the door
 * that overturns one. Page and sort are local state: the URL's q/page/sort
 * belong to the appointments list below. A row opens its booking.
 */
export function SessionOutcomesCard({
  onOpenBooking,
}: Readonly<{ onOpenBooking: (appointmentId: string) => void }>) {
  const [target, setTarget] = useState<NeedsHumanItem | null>(null);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<NeedsHumanSort>(NEEDS_HUMAN_DEFAULT_SORT);
  const queue = useQuery({
    queryKey: [...QUEUE_KEY, { page, sort }],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/sessions/needs-human?${needsHumanQueueSearch(page, sort)}`,
      );
      if (!res.ok) throw new Error("Failed to load");
      return (await res.json()) as NeedsHumanPage;
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const total = queue.data?.total ?? 0;
  // A decision can empty the last page; step back to the page that still exists.
  const lastPage = Math.max(1, Math.ceil(total / NEEDS_HUMAN_PAGE_SIZE));
  if (queue.data && page > lastPage) setPage(lastPage);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          Sessions that need a decision{total > 0 ? ` (${total})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ResponsiveTable<NeedsHumanItem>
          columns={columns}
          rows={queue.data?.items ?? []}
          getRowId={(s) => s.id}
          isLoading={queue.isLoading && !queue.data}
          error={queue.error && !queue.data ? queue.error : undefined}
          onRetry={() => void queue.refetch()}
          onRowClick={(s) => onOpenBooking(s.appointmentId)}
          sort={sort}
          onSortChange={(next) => {
            const picked = toQueueSort(next);
            if (!picked) return;
            setSort(picked);
            setPage(1);
          }}
          rowActions={(s) => (
            <Button size="sm" variant="outline" onClick={() => setTarget(s)}>
              Set outcome
            </Button>
          )}
          empty={<p className="text-muted-foreground">Nothing is waiting.</p>}
        />
        {total > NEEDS_HUMAN_PAGE_SIZE && (
          <TablePagination
            page={page}
            pageSize={NEEDS_HUMAN_PAGE_SIZE}
            total={total}
            onPageChange={setPage}
          />
        )}
      </CardContent>
      {target && (
        <SetOutcomeDialog
          key={target.id}
          occurrenceId={target.id}
          initial={target.outcome ?? "INCONCLUSIVE"}
          invalidate={[QUEUE_KEY, ["booking-ops"]]}
          onClose={() => setTarget(null)}
        />
      )}
    </Card>
  );
}
