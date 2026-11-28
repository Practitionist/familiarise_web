"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { formatPerson } from "@/lib/backoffice/person";
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
  NEEDS_HUMAN_SORT_OPTIONS,
  needsHumanQuerySchema,
  needsHumanQueueSearch,
  needsHumanSortToken,
  needsHumanPageSchema,
  type NeedsHumanItem,
  type NeedsHumanSort,
} from "@/lib/backoffice/needs-human-queue";
import {
  isNegativeMoneyOutcome,
  type NegativeMoneyOutcome,
} from "@/lib/booking/misses";
import { reportEffect } from "@/lib/booking/outcome-reports";
import { SESSION_OUTCOME_LABEL } from "@/lib/labels/session-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import {
  formatOperatorInstant,
  operatorEndKind,
} from "@/lib/time/operator-zone";
import { humanizeEnum } from "@/lib/ui/tone";
import {
  ConfirmOutcomeDialog,
  type ConfirmSession,
} from "./ConfirmOutcomeDialog";
import { RereadAttendanceDialog } from "./RereadAttendanceDialog";
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

type ConfirmTarget = {
  id: string;
  outcome: NegativeMoneyOutcome;
  session: ConfirmSession;
};

/** The row's own words for its session, so the dialog names what the operator clicked. */
function confirmSessionOf(s: NeedsHumanItem): ConfirmSession {
  return {
    title: s.booking.title || "Booking",
    expert: formatPerson(s.booking.expert).primary,
    learner: s.booking.attendeeLabel ?? formatPerson(s.booking.learner).primary,
    startsAt: s.startsAt,
    bookingType: s.booking.type,
    proposal:
      s.completionStatus === "UNVERIFIED" && s.outcome === "HOST_ABSENT",
  };
}

// One line in the table; a phone card wraps the time rather than clip it.
const NOWRAP = "md:whitespace-nowrap";
const CAP = "min-w-0 max-w-[11rem]";

/** Offered only for a negative verdict nobody has confirmed yet. */
function ConfirmButton({
  s,
  onConfirm,
}: Readonly<{
  s: NeedsHumanItem;
  onConfirm: (target: ConfirmTarget) => void;
}>) {
  const { outcome } = s;
  if (!s.canConfirm || !isNegativeMoneyOutcome(outcome)) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="max-w-full"
      aria-label={`Confirm outcome for ${s.booking.title || "booking"}, ${formatOperatorInstant(s.startsAt)}`}
      onClick={(e) => {
        e.stopPropagation();
        onConfirm({ id: s.id, outcome, session: confirmSessionOf(s) });
      }}
    >
      Confirm
    </Button>
  );
}

/** One badge per kind of report, linking to the first case filed; a dispute wins the wording of the row. */
function ReportBadges({ s }: Readonly<{ s: NeedsHumanItem }>) {
  const tree = useParams<{ tree?: string }>()?.tree ?? "admin";
  const { outcome } = s;
  if (!isNegativeMoneyOutcome(outcome)) return null;
  const dispute = s.reports.find(
    (r) => reportEffect(outcome, r.reason) === "dispute",
  );
  const agree = s.reports.find(
    (r) => reportEffect(outcome, r.reason) === "agree",
  );
  const badges = [
    dispute && {
      caseId: dispute.caseId,
      label:
        dispute.side === "HOST"
          ? "Disputed by the expert"
          : "Disputed by the learner",
      tone: "warning" as const,
    },
    agree && {
      caseId: agree.caseId,
      label: "Learner agrees",
      tone: "info" as const,
    },
  ].filter((b) => !!b);
  if (badges.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <Link
          key={b.caseId}
          href={`/dashboard/${tree}/support/c_${b.caseId}`}
          onClick={(e) => e.stopPropagation()}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <StatusBadge label={b.label} tone={b.tone} />
        </Link>
      ))}
    </div>
  );
}

/** Stacked cells keep the table inside the card at 1440 px; the door sits in the outcome cell. */
function queueColumns(
  onSetOutcome: (s: NeedsHumanItem) => void,
  onReread: (s: NeedsHumanItem) => void,
  onConfirm: (target: ConfirmTarget) => void,
): ResponsiveColumn<NeedsHumanItem>[] {
  return [
    {
      key: "booking",
      header: "Booking",
      primary: true,
      cell: (s) => (
        <div className={CAP}>
          <p className="truncate font-medium">{s.booking.title || "Booking"}</p>
          <p className="text-xs text-muted-foreground">
            {humanizeEnum(s.booking.type)}
            {s.booking.removed ? " · Removed" : ""}
          </p>
        </div>
      ),
    },
    {
      key: "people",
      header: "Expert / learner",
      cell: (s) => (
        <div className={`${CAP} space-y-2`}>
          <PersonCell person={s.booking.expert} />
          {s.booking.attendeeLabel ? (
            <p className="text-sm text-muted-foreground">
              {s.booking.attendeeLabel}
            </p>
          ) : (
            <PersonCell person={s.booking.learner} />
          )}
        </div>
      ),
    },
    {
      key: "startsAt",
      header: "Session",
      sortable: true,
      cell: (s) => (
        <div className="text-sm">
          <OperatorTime value={s.startsAt} kind="date" className={NOWRAP} />
          <p className={`text-xs text-muted-foreground ${NOWRAP}`}>
            <OperatorTime value={s.startsAt} kind="time" /> to{" "}
            <OperatorTime
              value={s.endsAt}
              kind={operatorEndKind(s.startsAt, s.endsAt)}
            />
          </p>
        </div>
      ),
    },
    {
      key: "outcomeAt",
      header: "Waiting since",
      sortable: true,
      // The sort puts a session with no verdict yet last, so its cell shows none.
      cell: (s) => (
        <div className="space-y-1 text-sm">
          <OperatorTime value={s.outcomeAt} kind="date" className={NOWRAP} />
          {s.outcomeAt && (
            <p className={`text-xs text-muted-foreground ${NOWRAP}`}>
              <OperatorTime value={s.outcomeAt} kind="time" />
            </p>
          )}
          {s.aged && (
            <span title="Its booking's settlement is on hold until this is decided.">
              <StatusBadge label="Over 7 days" tone="warning" />
            </span>
          )}
        </div>
      ),
    },
    {
      key: "lostMinutes",
      // Sorts by the minutes lost, which the cell's second line shows.
      header: "Outcome · minutes lost",
      sortable: true,
      cell: (s) => (
        <div className={`${CAP} space-y-1 text-sm`}>
          <p>{whyParked(s)}</p>
          <ReportBadges s={s} />
          <p className="text-xs text-muted-foreground">
            {s.lostMinutes ? `${s.lostMinutes} min lost` : "No minutes lost"}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="max-w-full"
            aria-label={`Set outcome for ${s.booking.title || "booking"}, ${formatOperatorInstant(s.startsAt)}`}
            onClick={(e) => {
              e.stopPropagation();
              onSetOutcome(s);
            }}
          >
            Set outcome
          </Button>
          {s.canRereadAttendance && (
            <Button
              size="sm"
              variant="ghost"
              className="max-w-full"
              aria-label={`Read from Stream again for ${s.booking.title || "booking"}, ${formatOperatorInstant(s.startsAt)}`}
              onClick={(e) => {
                e.stopPropagation();
                onReread(s);
              }}
            >
              Read from Stream again
            </Button>
          )}
          <ConfirmButton s={s} onConfirm={onConfirm} />
        </div>
      ),
    },
  ];
}

/**
 * Sessions the outcome sweep could not decide, a page at a time, and the door
 * that overturns one. Page and sort are local state: the URL's q/page/sort
 * belong to the appointments list below. A row opens its booking.
 */
export function SessionOutcomesCard({
  onOpenBooking,
}: Readonly<{ onOpenBooking: (appointmentId: string) => void }>) {
  const [target, setTarget] = useState<NeedsHumanItem | null>(null);
  const [rereadTarget, setRereadTarget] = useState<NeedsHumanItem | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(
    null,
  );
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<NeedsHumanSort>(NEEDS_HUMAN_DEFAULT_SORT);
  const queue = useQuery({
    queryKey: [...QUEUE_KEY, { page, sort }],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/sessions/needs-human?${needsHumanQueueSearch(page, sort)}`,
      );
      if (!res.ok) throw new Error("Failed to load");
      return needsHumanPageSchema.parse(await res.json());
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
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-lg">
          Sessions that need a decision{total > 0 ? ` (${total})` : ""}
        </CardTitle>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Sort</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
            value={needsHumanSortToken(sort)}
            onChange={(e) => {
              const picked = needsHumanQuerySchema.shape.sort.safeParse(
                e.target.value,
              );
              if (!picked.success) return;
              setSort(picked.data);
              setPage(1);
            }}
          >
            {NEEDS_HUMAN_SORT_OPTIONS.map((o) => (
              <option key={o.token} value={o.token}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ResponsiveTable<NeedsHumanItem>
          columns={queueColumns(setTarget, setRereadTarget, setConfirmTarget)}
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
      {rereadTarget && (
        <RereadAttendanceDialog
          key={rereadTarget.id}
          occurrenceId={rereadTarget.id}
          invalidate={[QUEUE_KEY]}
          onClose={() => setRereadTarget(null)}
        />
      )}
      {confirmTarget && (
        <ConfirmOutcomeDialog
          key={confirmTarget.id}
          occurrenceId={confirmTarget.id}
          outcome={confirmTarget.outcome}
          session={confirmTarget.session}
          invalidate={[QUEUE_KEY, ["booking-ops"]]}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </Card>
  );
}
