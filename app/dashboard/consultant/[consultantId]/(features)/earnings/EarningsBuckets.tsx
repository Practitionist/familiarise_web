"use client";

import type React from "react";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Building2,
  CheckCircle,
  Clock,
  Landmark,
  Wallet,
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";

import {
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { EmptyState } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IndiaOnlyPayoutNotice } from "@/components/payouts/IndiaOnlyPayoutNotice";
import { cn } from "@/utils/tailwind";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  BUCKET_LABEL,
  EARNINGS_FETCH_CAP,
  PAYOUT_ZONE,
  SEGMENT_LABEL,
  deriveEarningPresentation,
  derivePayoutPresentation,
  nextPayoutCopy,
  presentationBadge,
  type EarningBucket,
} from "@/lib/dashboard/earnings-state";
import type {
  ConsultantEarningRow,
  ConsultantEarningsPayload,
} from "@/lib/data/consultant-earnings-analytics";
import { PayoutWalkSheet } from "./PayoutWalkSheet";
import { GetPaidNowSheet } from "./GetPaidNowSheet";

/**
 * #1675 / #1527 W2 PR-Y — the Earnings summary: three tiles (Available ·
 * Pending · Paid out) and ONE segmented list (Available · Pending · Payouts),
 * every word from `lib/dashboard/earnings-state.ts`. An earning row walks the
 * money (price → platform fee → your share) and names the sponsor when an
 * organisation paid; a Payouts row is a payout with its share → TDS → net walk
 * in a sheet.
 */

/** Dates arrive as strings over JSON and as Dates from the RSC seed. */
type Json<T> = T extends Date
  ? string | Date
  : T extends object
    ? { [K in keyof T]: Json<T[K]> }
    : T;

export type EarningsResponse = Json<ConsultantEarningsPayload> & {
  livePayoutsEnabled?: boolean;
};
type EarningRow = Json<ConsultantEarningRow>;
type PayoutRow = EarningsResponse["payouts"][number];

const PAGE_SIZE = 15;

type Segment = EarningBucket;
/** Refunded appears as a fourth segment only when there is a refunded row to show. */
const SEGMENTS: Segment[] = ["AVAILABLE", "PENDING", "PAID_OUT"];

const inr = (paise: number) => formatCurrencyAmount(paise, "INR");
const onDay = (d: string | Date) =>
  formatInTimeZone(d, PAYOUT_ZONE, "d MMM yyyy");
const typeLabel = (type: string | null | undefined) =>
  type ? type.charAt(0) + type.slice(1).toLowerCase() : null;

/** The bank-account blocker: no verified account, or Y2's reason once it lands. */
function needsPayoutAccount(eligibility: EarningsResponse["eligibility"]) {
  const reason = (eligibility as { reason?: string }).reason;
  return (
    eligibility.hasPayoutAccount === false ||
    reason === "NO_ACCOUNT" ||
    reason === "UNVERIFIED"
  );
}

export function EarningsSkeleton() {
  return (
    <DashboardContent>
      <DashboardGrid columns={3}>
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </DashboardGrid>
      <div className="mt-6 space-y-3">
        <Skeleton className="h-9 w-72 rounded-lg" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </DashboardContent>
  );
}

export function EarningsBuckets({
  consultantId,
  data,
  now: nowProp,
  isStale = false,
  initialSegment = "AVAILABLE",
  isOwnDashboard = false,
}: Readonly<{
  consultantId: string;
  data: EarningsResponse;
  /** The instant-payout routes act on the viewer's own profile (#1771 row 6). */
  isOwnDashboard?: boolean;
  /** Injected by the pin; otherwise the clock is read once per mount. */
  now?: Date;
  isStale?: boolean;
  initialSegment?: Segment;
}>) {
  const [segment, setSegment] = useState<Segment>(initialSegment);
  const [page, setPage] = useState(0);
  // One instant per mount: a fresh `new Date()` per render would invalidate
  // the memos below on every render and let a row flip its hold line mid-view.
  const [mountedAt] = useState(() => new Date());
  const now = nowProp ?? mountedAt;
  // Default to FALSE: a missing flag reads "disbursement may not be live",
  // never "your money is on its way" (#776 §B).
  const live = data.livePayoutsEnabled ?? false;
  const opts = useMemo(() => ({ now, livePayoutsEnabled: live }), [now, live]);

  const rows = useMemo(
    () =>
      data.earnings.map((e) => ({
        earning: e,
        presentation: deriveEarningPresentation(e, opts),
      })),
    [data.earnings, opts],
  );
  // Whole-account sums from the read (Y-1's arithmetic run server-side), so
  // the tiles are never a partial total of the rows fetched.
  const sums = data.totals;
  const counts = useMemo(() => {
    const c: Record<Segment, number> = {
      AVAILABLE: 0,
      PENDING: 0,
      PAID_OUT: data.payouts.length,
      REFUNDED: 0,
    };
    for (const r of rows) {
      if (r.presentation.bucket !== "PAID_OUT") c[r.presentation.bucket] += 1;
    }
    return c;
  }, [rows, data.payouts.length]);

  const lastPaid = data.payouts.find((p) => p.status === "COMPLETED");
  const segments: Segment[] =
    counts.REFUNDED > 0 ? [...SEGMENTS, "REFUNDED"] : SEGMENTS;
  const shownRows =
    segment === "PAID_OUT"
      ? []
      : rows.filter((r) => r.presentation.bucket === segment);
  const pageRows = shownRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(shownRows.length / PAGE_SIZE));

  const select = (s: Segment) => {
    setSegment(s);
    setPage(0);
  };

  let segmentBody: React.ReactNode;
  if (segment === "PAID_OUT") {
    segmentBody = <PayoutList payouts={data.payouts} />;
  } else if (pageRows.length === 0) {
    segmentBody = (
      <EmptyState
        icon={Wallet}
        title={`Nothing ${SEGMENT_LABEL[segment].toLowerCase()} right now`}
        description={
          segment === "AVAILABLE"
            ? "Earnings move here once their hold clears."
            : "Earnings appear here after your sessions are paid."
        }
      />
    );
  } else {
    segmentBody = (
      <ul className="divide-y divide-border">
        {pageRows.map(({ earning, presentation }) => (
          <EarningItem
            key={earning.id}
            earning={earning}
            badge={presentationBadge(presentation)}
            line={presentation.line}
          />
        ))}
      </ul>
    );
  }

  return (
    <DashboardContent>
      {needsPayoutAccount(data.eligibility) && (
        <output className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900 dark:bg-amber-950">
          <div className="flex items-start gap-3">
            <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                Add your bank account to get paid
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-200">
                Your balance stays with us until a verified Indian bank account
                is on file.
              </p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link
              href={`/dashboard/consultant/${consultantId}/settings/payouts`}
            >
              Get paid
            </Link>
          </Button>
        </output>
      )}

      <DashboardGrid columns={3}>
        <div className="flex flex-col gap-2">
          <StatCard
            title={BUCKET_LABEL.AVAILABLE}
            value={inr(sums.available)}
            icon={CheckCircle}
            variant="success"
            subtitle={nextPayoutCopy(now, live)}
            tooltip="Cleared earnings, less anything refunded, waiting for the next payout run."
          />
          {/* #1771 row 6 — hidden for other viewers, while payouts are off, or at zero. */}
          {isOwnDashboard && live && sums.available > 0 && (
            <GetPaidNowSheet consultantId={consultantId} />
          )}
        </div>
        <StatCard
          title={BUCKET_LABEL.PENDING}
          value={inr(sums.pending)}
          icon={Clock}
          variant="warning"
          subtitle="Clears after your sessions and the hold"
          tooltip="Earnings still in their hold, on a dispute or account hold, or waiting on a sponsoring organisation's first paid invoice."
        />
        <StatCard
          title={BUCKET_LABEL.PAID_OUT}
          value={inr(sums.paidOut)}
          icon={Wallet}
          variant="info"
          subtitle={
            lastPaid
              ? `Last paid ${onDay(lastPaid.processedAt ?? lastPaid.createdAt)}`
              : "Nothing paid out yet"
          }
          tooltip="What reached your bank, after TDS."
        />
      </DashboardGrid>

      {/* A filter over one list, not tab panels: pressed buttons, not tabs. */}
      <fieldset className="mt-6 inline-flex rounded-lg border-0 bg-muted p-1">
        <legend className="sr-only">Earnings</legend>
        {segments.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={segment === s}
            onClick={() => select(s)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              segment === s
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {SEGMENT_LABEL[s]}
            <span className="ml-1.5 text-xs text-muted-foreground">
              {counts[s]}
            </span>
          </button>
        ))}
      </fieldset>
      {segment === "PAID_OUT" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Every payout and where it is
        </p>
      )}

      <div
        className={cn(
          "mt-4 overflow-hidden rounded-xl border border-border bg-card transition-opacity",
          isStale ? "opacity-60" : "opacity-100",
        )}
        aria-busy={isStale}
      >
        {segmentBody}

        {segment !== "PAID_OUT" && shownRows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-border bg-muted/40 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              Page {page + 1} of {pageCount}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={page + 1 >= pageCount}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {data.pagination.hasMore && (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing your latest {EARNINGS_FETCH_CAP} earnings.
        </p>
      )}

      <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
        <div className="flex items-start gap-3">
          <ArrowUpRight className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              Payout information
            </p>
            <IndiaOnlyPayoutNotice variant="compact" className="mt-1" />
            <EligibilityBar eligibility={data.eligibility} />
          </div>
        </div>
      </div>
    </DashboardContent>
  );
}

function EligibilityBar({
  eligibility,
}: Readonly<{ eligibility: EarningsResponse["eligibility"] }>) {
  if (eligibility.isEligible) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        {inr(eligibility.readyAmount)} ready — paid out weekly
      </p>
    );
  }
  const pct = Math.min(
    100,
    Math.round((eligibility.readyAmount / eligibility.minimumAmount) * 100),
  );
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {inr(eligibility.readyAmount)} of {inr(eligibility.minimumAmount)}{" "}
          minimum reached
        </p>
        <p className="text-xs font-medium text-foreground">{pct}%</p>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function EarningItem({
  earning,
  badge,
  line,
}: Readonly<{
  earning: EarningRow;
  badge: ReturnType<typeof presentationBadge>;
  line: string;
}>) {
  const currency = earning.payment.currency ?? "INR";
  const money = (paise: number) => formatCurrencyAmount(paise, currency);
  const title =
    earning.title ??
    typeLabel(earning.payment.appointment?.appointmentType) ??
    "Booking";
  const role =
    earning.role === "COLLABORATOR"
      ? `Collab ${earning.shareBps / 100} %`
      : `Owner ${earning.shareBps / 100} %`;
  return (
    <li className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <span className="text-xs text-muted-foreground">
            {onDay(earning.createdAt)}
          </span>
          {earning.sponsorOrgName && (
            <Badge className="gap-1 rounded-md border-0 bg-muted px-1.5 py-0 text-[10px] font-semibold text-muted-foreground">
              <Building2 className="h-3 w-3" aria-hidden />
              {earning.sponsorOrgName}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-foreground">
          {money(earning.grossAmount)}
          <span className="text-muted-foreground"> → −</span>
          {money(earning.platformFeePaise)}
          <span className="text-muted-foreground"> platform → </span>
          <strong>{money(earning.consultantSharePaise)} yours</strong>
          <span className="text-muted-foreground"> ({role})</span>
          {earning.refundedShareAmount > 0 && earning.status !== "REFUNDED" && (
            <span className="text-muted-foreground">
              {" "}
              · {money(earning.refundedShareAmount)} refunded
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge {...badge} size="sm" />
        <span className="text-xs text-muted-foreground">{line}</span>
      </div>
    </li>
  );
}

function PayoutList({ payouts }: Readonly<{ payouts: PayoutRow[] }>) {
  if (payouts.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="No payouts yet"
        description="Each transfer to your bank shows up here with its TDS and UTR."
      />
    );
  }
  return (
    <ul className="divide-y divide-border">
      {payouts.map((p) => {
        const pres = derivePayoutPresentation(p);
        const net = p.netAmount ?? p.amount - p.tdsDeducted;
        return (
          <li key={p.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-foreground">
                  {inr(net)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {onDay(p.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{pres.line}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <StatusBadge {...presentationBadge(pres)} size="sm" />
              <PayoutWalkSheet payout={p} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
