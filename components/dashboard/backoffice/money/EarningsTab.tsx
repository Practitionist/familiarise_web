"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Input } from "@/components/ui/input";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { BookingCell } from "@/components/dashboard/backoffice/BookingCell";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import {
  earningListPageSchema,
  readListBody,
  type EarningListItem,
} from "@/lib/backoffice/money-list-schemas";
import { earningStatusBadge } from "@/lib/labels/session-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { formatCurrencyAmount } from "@/utils/formatting";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

type EarningRow = EarningListItem;

const PAGE_SIZE = 20;

// #1527 — PENDING_TRUST (org-funded, awaiting the org's first invoice) was
// unfilterable; HELD leads because the page opens on it.
const STATUSES = [
  "HELD",
  "PENDING",
  "PENDING_TRUST",
  "READY",
  "BATCHED",
  "PAID",
  "REFUNDED",
];
const QUERY_KEY = ["money-earnings"] as const;

function doorFor(status: string): "hold" | "release" | null {
  if (status === "HELD") return "release";
  if (status === "PENDING" || status === "READY") return "hold";
  return null;
}

async function fetchEarnings(filters: Record<string, string>, page: number) {
  const params = new URLSearchParams({
    ...filters,
    limit: String(PAGE_SIZE),
    offset: String((page - 1) * PAGE_SIZE),
  });
  const res = await fetch(`/api/admin/earnings?${params}`);
  return readListBody(res, earningListPageSchema, "Failed to load earnings");
}

const earningColumns = (basePath: string): ResponsiveColumn<EarningRow>[] => [
  {
    key: "consultant",
    header: "Expert",
    primary: true,
    cell: (r) => (
      <PersonCell
        person={{
          id: r.consultantProfile.userId,
          name: r.consultantProfile.user.name,
          email: r.consultantProfile.user.email,
        }}
      />
    ),
  },
  {
    key: "buyer",
    header: "Buyer",
    cell: (r) => <PersonCell person={r.payment?.buyer} />,
  },
  {
    key: "booking",
    header: "Booking",
    cell: (r) => (
      <div className="min-w-0 space-y-1">
        <BookingCell booking={r.payment?.booking} basePath={basePath} />
        <p className="truncate font-mono text-[11px] text-muted-foreground/70">
          {r.paymentId}
        </p>
      </div>
    ),
  },
  {
    key: "share",
    header: "Share",
    cell: (r) => formatCurrencyAmount(r.consultantSharePaise, "INR"),
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => <StatusBadge {...earningStatusBadge(r.status)} />,
  },
  {
    key: "hold",
    header: "Hold until",
    cell: (r) => <OperatorTime value={r.holdUntil} fallback="Not set" />,
  },
];

type Acting = { row: EarningRow; kind: "hold" | "release" };

/** Row actions built outside render, so the table never remounts them. */
function earningActions(onAct: (acting: Acting) => void) {
  return function EarningAction(r: EarningRow) {
    const kind = doorFor(r.status);
    return kind ? (
      <Button
        size="sm"
        variant="outline"
        onClick={() => onAct({ row: r, kind })}
      >
        {kind === "hold" ? "Hold" : "Release"}
      </Button>
    ) : null;
  };
}

/**
 * #1771 K-3 — the Earnings tab: filter by status, consultant or payment, and
 * hold or release one row with a reason. Release answers READY only when the
 * hold has matured and nothing is open on the payment.
 */
export function EarningsTab() {
  // #1527 — held earnings are the ones waiting on an operator.
  const [status, setStatus] = useState("HELD");
  const [consultantProfileId, setConsultantProfileId] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [page, setPage] = useState(1);
  const { basePath } = useBackofficeCapability();
  const columns = useMemo(() => earningColumns(basePath), [basePath]);
  const [acting, setActing] = useState<Acting | null>(null);
  const rowActions = useMemo(() => earningActions(setActing), []);

  const filters: Record<string, string> = {
    ...(status === "all" ? {} : { status }),
    ...(consultantProfileId.trim()
      ? { consultantProfileId: consultantProfileId.trim() }
      : {}),
    ...(paymentId.trim() ? { paymentId: paymentId.trim() } : {}),
  };
  const { data, isLoading, error } = useQuery({
    queryKey: [...QUERY_KEY, filters, page],
    queryFn: () => fetchEarnings(filters, page),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const door = useOpsDoor({
    success: acting?.kind === "hold" ? "Earning held" : "Earning released",
    invalidate: [QUERY_KEY],
    onDone: () => setActing(null),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Earnings"
        description="Filter expert shares by settlement state, hold pending payouts, or release mature holds."
      />
      <Card>
        <CardContent className="pt-6 space-y-4">
          <FilterBar
            selects={[
              {
                key: "status",
                label: "Status",
                value: status,
                options: [
                  { value: "all", label: "Every status" },
                  ...STATUSES.map((s) => ({
                    value: s,
                    label: earningStatusBadge(s).label,
                  })),
                ],
                onChange: (v) => {
                  setStatus(v);
                  setPage(1);
                },
              },
            ]}
          >
            <Input
              className="h-9 w-48"
              aria-label="Expert profile id"
              placeholder="Expert profile id"
              value={consultantProfileId}
              onChange={(e) => {
                setConsultantProfileId(e.target.value);
                setPage(1);
              }}
            />
            <Input
              className="h-9 w-48"
              aria-label="Payment id"
              placeholder="Payment id"
              value={paymentId}
              onChange={(e) => {
                setPaymentId(e.target.value);
                setPage(1);
              }}
            />
          </FilterBar>
          {error ? (
            <p className="text-sm text-destructive">Earnings could not load.</p>
          ) : (
            <>
              <ResponsiveTable<EarningRow>
                columns={columns}
                rows={isLoading ? [] : (data?.earnings ?? [])}
                getRowId={(r) => r.id}
                rowActions={rowActions}
                empty={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {isLoading
                      ? "Loading…"
                      : "No earnings match these filters."}
                  </p>
                }
              />
              <TablePagination
                page={page}
                pageSize={PAGE_SIZE}
                total={data?.pagination.total ?? 0}
                onPageChange={setPage}
              />
            </>
          )}
        </CardContent>
        <ReasonDialog
          open={acting !== null}
          onOpenChange={(o) => !o && setActing(null)}
          title={
            acting?.kind === "hold"
              ? "Hold this earning"
              : "Release this earning"
          }
          description={
            acting?.kind === "hold"
              ? "A held earning is skipped by the release job and every payout until it is released."
              : "It goes back to Ready if its hold period is over, otherwise to Pending."
          }
          confirmLabel={acting?.kind === "hold" ? "Hold" : "Release"}
          pending={door.isPending}
          onConfirm={(reason) =>
            acting &&
            door.mutate({
              url: `/api/admin/earnings/${acting.row.id}/${acting.kind}`,
              body: { reason },
            })
          }
        />
      </Card>
    </div>
  );
}
