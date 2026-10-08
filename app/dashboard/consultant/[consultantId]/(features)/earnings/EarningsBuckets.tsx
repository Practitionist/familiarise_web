"use client";

import type React from "react";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Building2,
  Download,
  FileText,
  Landmark,
  Sparkles,
  Wallet,
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";

import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { Section } from "@/components/dashboard/Section";
import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { EmptyState } from "@/components/dashboard/DataCard";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import type { OfferingStat, OfferingStats } from "@/lib/offerings/stats";
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
  payoutNet,
  presentationBadge,
  type EarningBucket,
} from "@/lib/dashboard/earnings-state";
import type {
  ConsultantEarningRow,
  ConsultantEarningsPayload,
  ConsultantTdsRecordRow,
} from "@/lib/data/consultant-earnings-analytics";
import { PayoutWalkSheet } from "./PayoutWalkSheet";
import { GetPaidNowSheet } from "./GetPaidNowSheet";

const IST_OFFSET_MS = 330 * 60 * 1000;

function getIndianFinancialYear(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const startYear = month >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function getIndianFYQuarter(date: Date): number {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const month = ist.getUTCMonth();
  if (month >= 3 && month <= 5) return 1;
  if (month >= 6 && month <= 8) return 2;
  if (month >= 9 && month <= 11) return 3;
  return 4;
}

/** Dates arrive as strings over JSON and as Dates from the RSC seed. */
type Json<T> = T extends Date
  ? string | Date
  : T extends object
    ? { [K in keyof T]: Json<T[K]> }
    : T;

export type EarningsResponse = Omit<
  Json<ConsultantEarningsPayload>,
  | "feeSchedule"
  | "feeWaiver"
  | "tdsRecords"
  | "attributionBreakdown"
  | "repeatLearnerStats"
> & {
  livePayoutsEnabled?: boolean;
  feeSchedule?: Json<ConsultantEarningsPayload["feeSchedule"]>;
  feeWaiver?: Json<ConsultantEarningsPayload["feeWaiver"]>;
  tdsRecords?: Json<ConsultantEarningsPayload["tdsRecords"]>;
  attributionBreakdown?: Json<
    ConsultantEarningsPayload["attributionBreakdown"]
  >;
  repeatLearnerStats?: Json<ConsultantEarningsPayload["repeatLearnerStats"]>;
};
type EarningRow = Json<ConsultantEarningRow>;
type PayoutRow = EarningsResponse["payouts"][number];
type TdsRow = Json<ConsultantTdsRecordRow>;

const PAGE_SIZE = 15;

type Segment = EarningBucket;
/** Refunded appears as a fourth segment only when there is a refunded row to show. */
const SEGMENTS: Segment[] = ["AVAILABLE", "PENDING", "PAID_OUT"];

const inr = (paise: number) => formatCurrencyAmount(paise, "INR");
const onDay = (d: string | Date) =>
  formatInTimeZone(d, PAYOUT_ZONE, "d MMM yyyy");
const typeLabel = (type: string | null | undefined) =>
  type ? type.charAt(0) + type.slice(1).toLowerCase() : null;

function formatBpsPercent(bps: number): string {
  const pct = bps / 100;
  return `${bps % 100 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`;
}

function normalizeTdsSection(section: string | null | undefined): string {
  if (!section || section === "194O") return "194-O";
  return section;
}

function csvCell(val: string | number | boolean | null | undefined): string {
  const raw = val === null || val === undefined ? "" : String(val);
  const isNumeric = /^[+-]?\d+(\.\d+)?$/.test(raw.trim());
  const safe = !isNumeric && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return safe;
}

function deriveEarningSourceLabel(e: EarningRow): string {
  if (e.sponsorOrgName) {
    return `Sponsored (${e.sponsorOrgName})`;
  }
  const isWaived =
    e.grossAmount > 0 &&
    (e.payment.platformFeeBps === 0 || e.platformFeePaise === 0);
  if (isWaived) {
    return "Fee waived (0%)";
  }
  const rateSuffix =
    typeof e.payment.platformFeeBps === "number"
      ? ` (${formatBpsPercent(e.payment.platformFeeBps)})`
      : "";
  if (e.payment.attributionSource === "OWN_LINK") {
    return `Own link${rateSuffix}`;
  }
  return `Marketplace${rateSuffix}`;
}

function downloadFyEarningsCsv(data: EarningsResponse) {
  const headers = [
    "Record Type",
    "Financial Year",
    "Quarter",
    "Date",
    "Reference ID",
    "Title / Section",
    "Attribution / Filing Status",
    "Gross Amount (INR)",
    "Platform Fee (INR)",
    "Net Consultant Share (INR)",
    "FY Cumulative Credited (INR)",
    "TDS Deducted (INR)",
    "TDS Rate (%)",
    "Form 16A (Form 131) / Challan",
  ];
  const lines: string[] = [headers.map(csvCell).join(",")];

  for (const e of data.earnings) {
    const createdDate = new Date(e.createdAt);
    const fy = getIndianFinancialYear(createdDate);
    const quarter = `Q${getIndianFYQuarter(createdDate)}`;
    const source = deriveEarningSourceLabel(e);
    lines.push(
      [
        "EARNING",
        fy,
        quarter,
        onDay(e.createdAt),
        e.id,
        e.title ??
          typeLabel(e.payment.appointment?.appointmentType) ??
          "Booking",
        source,
        (e.grossAmount / 100).toFixed(2),
        (e.platformFeePaise / 100).toFixed(2),
        (e.consultantSharePaise / 100).toFixed(2),
        "",
        "",
        "",
        "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  for (const t of data.tdsRecords ?? []) {
    lines.push(
      [
        t.isReversal ? "TDS_REVERSAL" : "TDS_DEDUCTION",
        t.financialYear,
        `Q${t.quarter}`,
        onDay(t.createdAt),
        t.payoutId ?? t.id,
        normalizeTdsSection(t.tdsSection),
        t.reportedInForm26Q
          ? "Reported in Form 26Q (Form 140)"
          : "Pending Form 26Q (Form 140)",
        "",
        "",
        "",
        (t.cumulativeAmountCredited / 100).toFixed(2),
        (t.tdsDeducted / 100).toFixed(2),
        (t.tdsRateBps / 100).toFixed(2),
        t.certificateNumber ?? t.challanNumber ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  if (data.pagination.hasMore) {
    lines.push(
      [
        "NOTE",
        getIndianFinancialYear(new Date()),
        "",
        "",
        "",
        `B2C earning rows truncated at ${EARNINGS_FETCH_CAP} most recent entries`,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  const blob = new Blob([`\uFEFF${lines.join("\n")}`], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `familiarise-earnings-tds-${getIndianFinancialYear(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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
      <StatRow columns={4}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
      <div className="space-y-3">
        <Skeleton className="h-9 w-72 rounded-lg" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </DashboardContent>
  );
}

/** The soonest hold that clears, among Pending rows (#1827: "with the date"). */
function nextClearDate(rows: EarningRow[], now: Date): Date | null {
  let soonest: Date | null = null;
  for (const row of rows) {
    if (!row.holdUntil) continue;
    const at = new Date(row.holdUntil);
    if (at > now && (!soonest || at < soonest)) soonest = at;
  }
  return soonest;
}

/**
 * #1527 §7.2 / #1827 — the Summary tab: four tiles (Available · Pending ·
 * Paid out · Lifetime), when the next payout runs, what each offering earned
 * (₹0 rows included) and one line on the platform fee.
 */
export function EarningsSummary({
  consultantId,
  data,
  now: nowProp,
  isOwnDashboard = false,
  stats,
}: Readonly<{
  consultantId: string;
  data: EarningsResponse;
  /** The instant-payout routes act on the viewer's own profile (#1771 row 6). */
  isOwnDashboard?: boolean;
  /** Injected by the pin; otherwise the clock is read once per mount. */
  now?: Date;
  /** Owner-only per-offering read; absent while loading or for inspectors. */
  stats?: OfferingStats | null;
}>) {
  const [mountedAt] = useState(() => new Date());
  const now = nowProp ?? mountedAt;
  // Default to FALSE: a missing flag reads "disbursement may not be live",
  // never "your money is on its way" (#776 §B).
  const live = data.livePayoutsEnabled ?? false;
  const opts = useMemo(() => ({ now, livePayoutsEnabled: live }), [now, live]);
  // Whole-account sums from the read (Y-1's arithmetic run server-side), so
  // the tiles are never a partial total of the rows fetched.
  const sums = data.totals;
  const pendingRows = useMemo(
    () =>
      data.earnings.filter(
        (e) => deriveEarningPresentation(e, opts).bucket === "PENDING",
      ),
    [data.earnings, opts],
  );
  const nextClear = nextClearDate(pendingRows, now);
  const lastPaid = data.payouts.find((p) => p.status === "COMPLETED");
  const base = `/dashboard/consultant/${consultantId}`;
  const feeWaiver = data.feeWaiver ?? null;
  const tdsRecords = data.tdsRecords ?? [];

  return (
    <DashboardContent>
      {needsPayoutAccount(data.eligibility) && (
        <output className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Add your bank account to get paid
              </p>
              <p className="text-xs text-muted-foreground">
                Your balance stays with us until a verified Indian bank account
                is on file.
              </p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`${base}/settings/get-paid`}>Get paid</Link>
          </Button>
        </output>
      )}

      {(feeWaiver?.sessionsRemaining ?? 0) > 0 && feeWaiver && (
        <output className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {feeWaiver.sessionsRemaining} fee-free{" "}
              {feeWaiver.sessionsRemaining === 1 ? "session" : "sessions"}{" "}
              remaining until {onDay(feeWaiver.expiresAt)}
            </p>
            <p className="text-xs text-muted-foreground">
              0% platform fee on your next qualifying personal-practice bookings
              (not on orders using a learner discount or credit; before TDS).
            </p>
          </div>
        </output>
      )}

      <StatRow columns={4}>
        <Stat
          label={BUCKET_LABEL.AVAILABLE}
          value={inr(sums.available)}
          hint="Cleared, less refunds, waiting for a payout"
        />
        <Stat
          label={BUCKET_LABEL.PENDING}
          value={inr(sums.pending)}
          hint={
            nextClear
              ? `Next clears on ${onDay(nextClear)}`
              : "Clears after your sessions and the hold"
          }
        />
        <Stat
          label={BUCKET_LABEL.PAID_OUT}
          value={inr(sums.paidOut)}
          hint={
            lastPaid
              ? `Last paid ${onDay(lastPaid.processedAt ?? lastPaid.createdAt)}`
              : "Nothing paid out yet"
          }
        />
        <Stat
          label="Lifetime"
          value={stats ? inr(stats.lifetimePaise) : "—"}
          hint="Everything you've earned, before TDS"
        />
      </StatRow>

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-foreground">
          <span className="font-medium">Next payout: </span>
          {nextPayoutCopy(now, live)}
        </p>
        {isOwnDashboard && live && sums.available > 0 && (
          <GetPaidNowSheet consultantId={consultantId} />
        )}
      </div>

      <div className="rounded-lg border border-border bg-muted/40 p-4">
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

      {stats !== undefined && <ByOfferingTable stats={stats} />}

      <TdsSummarySection tdsRecords={tdsRecords} data={data} />

      <p className="text-sm text-muted-foreground">
        {data.feeSchedule
          ? `Familiarise charges ${formatBpsPercent(data.feeSchedule.ownLinkBps)} when a buyer first discovers and purchases from you via your shared link (?via=) · ${formatBpsPercent(data.feeSchedule.marketplaceBps)} for Marketplace-acquired buyers · 0% on qualifying fee-waived bookings; sessions an organisation pays for follow that organisation's agreement.`
          : "Platform fee rates follow the active schedule (reduced own-link rate when a buyer first discovers and purchases from you via ?via=, standard rate for Marketplace-acquired buyers); sessions an organisation pays for follow that organisation's agreement."}{" "}
        <Link
          href="/support/experts/payouts"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Payout FAQs
        </Link>
      </p>
    </DashboardContent>
  );
}

const OFFERING_TYPE_WORD = {
  consultation: "1:1",
  subscription: "Subscription",
  webinar: "Webinar",
  class: "Class",
} as const;

function ByOfferingTable({ stats }: Readonly<{ stats: OfferingStats | null }>) {
  const rows = useMemo(
    () =>
      [...(stats?.rows ?? [])].sort(
        (a, b) => b.earningsPaise - a.earningsPaise || b.bookings - a.bookings,
      ),
    [stats],
  );
  const columns: ResponsiveColumn<OfferingStat>[] = [
    {
      key: "title",
      header: "Offering",
      primary: true,
      cell: (row) => (
        <span className="font-medium text-foreground">{row.title}</span>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (row) => OFFERING_TYPE_WORD[row.planType],
    },
    {
      key: "bookings",
      header: "Bookings",
      className: "tabular-nums",
      cell: (row) => row.bookings,
    },
    {
      key: "earned",
      header: "Earned",
      className: "tabular-nums",
      cell: (row) => inr(row.earningsPaise),
    },
  ];
  return (
    <Section title="By offering">
      <ResponsiveTable
        columns={columns}
        rows={rows}
        getRowId={(row) => `${row.planType}:${row.planId}`}
        error={stats === null ? true : undefined}
        empty={
          <EmptyState
            icon={Wallet}
            title="No offerings yet"
            description="Each offering you create shows here with what it has earned."
          />
        }
      />
    </Section>
  );
}

const TDS_COLUMNS: ResponsiveColumn<TdsRow>[] = [
  {
    key: "period",
    header: "FY & Quarter",
    primary: true,
    cell: (row) => (
      <span className="font-medium text-foreground">
        FY {row.financialYear} · Q{row.quarter}
      </span>
    ),
  },
  {
    key: "section",
    header: "Section & Rate",
    cell: (row) => {
      const rate = (row.tdsRateBps / 100).toFixed(
        row.tdsRateBps % 100 === 0 ? 0 : 1,
      );
      return `s.${normalizeTdsSection(row.tdsSection)} · ${rate}%`;
    },
  },
  {
    key: "credited",
    header: "Cumulative Credited",
    className: "tabular-nums",
    cell: (row) => inr(row.cumulativeAmountCredited),
  },
  {
    key: "tds",
    header: "TDS Deducted",
    className: "tabular-nums",
    cell: (row) => inr(row.tdsDeducted),
  },
  {
    key: "filing",
    header: "Form 16A (Form 131) / Challan",
    cell: (row) => {
      if (row.certificateNumber) {
        return (
          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Cert {row.certificateNumber}
          </span>
        );
      }
      if (row.challanNumber) {
        return (
          <span className="text-xs text-foreground">
            Challan {row.challanNumber}
          </span>
        );
      }
      return (
        <span className="text-xs text-muted-foreground">
          {row.reportedInForm26Q
            ? "Reported in Form 26Q (Form 140)"
            : "Pending Form 26Q (Form 140)"}
        </span>
      );
    },
  },
];

function TdsSummarySection({
  tdsRecords,
  data,
}: Readonly<{
  tdsRecords: TdsRow[];
  data: EarningsResponse;
}>) {
  const columns = TDS_COLUMNS;

  return (
    <Section
      title="Tax & TDS — Form 16A (Form 131)"
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => downloadFyEarningsCsv(data)}
          className="gap-1.5"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Export FY Earnings &amp; Tax CSV
        </Button>
      }
    >
      {tdsRecords.length > 0 ? (
        <ResponsiveTable
          columns={columns}
          rows={tdsRecords}
          getRowId={(row) => row.id}
        />
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">
              No TDS deductions recorded yet
            </p>
            <p className="text-xs text-muted-foreground">
              Section 194-O / 194J deductions, challan numbers, and Form 16A
              (Form 131) certificate references appear here by financial year
              and quarter.
            </p>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * #1527 §13b — the Activity tab: the one segmented list (Available · Pending ·
 * Payouts) that used to sit under the tiles.
 */
export function EarningsActivity({
  consultantId,
  data,
  now: nowProp,
  isStale = false,
  initialSegment = "AVAILABLE",
}: Readonly<{
  consultantId: string;
  data: EarningsResponse;
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
    segmentBody = (
      <PayoutList
        payouts={data.payouts}
        base={`/dashboard/consultant/${consultantId}`}
      />
    );
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
      <div>
        {/* A filter over one list, not tab panels: pressed buttons, not tabs. */}
        <fieldset className="inline-flex rounded-lg border-0 bg-muted p-1">
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
            Every payout and where it is. Payouts include earnings from
            organizations you deliver for.
          </p>
        )}
      </div>

      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-card transition-opacity",
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
        <p className="text-xs text-muted-foreground">
          Showing your latest {EARNINGS_FETCH_CAP} earnings.
        </p>
      )}
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
  const isFeeWaived =
    !earning.sponsorOrgName &&
    earning.grossAmount > 0 &&
    (earning.payment.platformFeeBps === 0 || earning.platformFeePaise === 0);
  const isOwnLink =
    !earning.sponsorOrgName &&
    !isFeeWaived &&
    earning.payment.attributionSource === "OWN_LINK";
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
          {isFeeWaived && (
            <Badge className="rounded-md border-0 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
              Fee waived · ₹0 fee
            </Badge>
          )}
          {isOwnLink && (
            <Badge className="rounded-md border-0 bg-sky-500/10 px-1.5 py-0 text-[10px] font-semibold text-sky-700 dark:text-sky-400">
              Own link
              {typeof earning.payment.platformFeeBps === "number"
                ? ` · ${formatBpsPercent(earning.payment.platformFeeBps)} fee`
                : ""}
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

function PayoutList({
  payouts,
  base,
}: Readonly<{ payouts: PayoutRow[]; base: string }>) {
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
        const net = payoutNet(p);
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
              <Link
                href={`${base}/earnings/payouts/${p.id}`}
                className="text-xs font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground"
              >
                Details
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
