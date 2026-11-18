"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { callOpsDoor } from "@/components/dashboard/backoffice/money/ops-door";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { readListBody } from "@/lib/backoffice/money-list-schemas";
import {
  feeSchedulePageSchema,
  type FeeSchedule,
} from "@/lib/backoffice/people-list-schemas";
import { OperatorTime } from "@/lib/time/operator-time";
import { fromOperatorWallTime } from "@/lib/time/operator-zone";

const PAGE_SIZE = 20;
const QUERY_KEY = "admin-fee-schedules";

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

const MAX_PROPOSED_BPS = 5000;

/** A fee typed in basis points: a whole number from 0 to 5000, else null ("1e3" and "12.5" are refused). */
export function parseWholeBps(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const bps = Number(text);
  return bps <= MAX_PROPOSED_BPS ? bps : null;
}

async function fetchSchedules(page: number) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(PAGE_SIZE),
  });
  const res = await fetch(`/api/admin/fee-schedules?${params}`);
  return readListBody(
    res,
    feeSchedulePageSchema,
    "Platform fee schedules could not load.",
  );
}

const COLUMNS: ResponsiveColumn<FeeSchedule>[] = [
  {
    key: "rates",
    header: "Take rates",
    primary: true,
    cell: (s) => (
      <div className="font-medium tabular-nums">
        Marketplace {pct(s.marketplaceBps)} ({s.marketplaceBps} bps) · Own link{" "}
        {pct(s.ownLinkBps)} ({s.ownLinkBps} bps)
      </div>
    ),
  },
  {
    key: "effectiveFrom",
    header: "Effective from",
    cell: (s) => <OperatorTime value={s.effectiveFrom} />,
  },
  {
    key: "maker",
    header: "Proposed by",
    cell: (s) => <PersonCell person={makerOrSystem(s.maker)} />,
  },
  {
    key: "checker",
    header: "Approved by",
    cell: (s) =>
      s.checker ? <PersonCell person={s.checker} /> : "Waiting for a checker",
  },
  {
    key: "status",
    header: "Status",
    cell: (s) => (
      <StatusBadge
        label={s.approvedAt ? "Approved" : "Waiting for approval"}
        tone={s.approvedAt ? "success" : "warning"}
      />
    ),
  },
];

/** A maker with no user row is the seed or a job, never a removed person. */
export function makerOrSystem<
  P extends { name: string | null; email: string | null },
>(person: P): P {
  return person.name || person.email ? person : { ...person, name: "System" };
}

/** The platform take-rate schedules: history, the rates in force, and the maker-checker doors. */
export function PlatformFeesPageClient() {
  const { can } = useBackofficeCapability();
  const canManage = can("payments.manage");
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [marketplaceBps, setMarketplaceBps] = useState("1500");
  const [ownLinkBps, setOwnLinkBps] = useState("500");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [proposeReason, setProposeReason] = useState("");
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<FeeSchedule | null>(null);

  const list = useQuery({
    queryKey: [QUERY_KEY, page],
    queryFn: () => fetchSchedules(page),
    placeholderData: keepPreviousData,
  });

  const propose = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      callOpsDoor("/api/admin/fee-schedules", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      setProposeReason("");
      setEffectiveFrom("");
      setProposeError(null);
    },
    onError: (err: Error) => setProposeError(err.message),
  });

  const handlePropose = () => {
    setProposeError(null);
    const mkt = parseWholeBps(marketplaceBps);
    const own = parseWholeBps(ownLinkBps);
    if (mkt === null) {
      setProposeError(
        "Marketplace BPS must be a whole number from 0 to 5000 (0–50%).",
      );
      return;
    }
    if (own === null) {
      setProposeError(
        "Own-link BPS must be a whole number from 0 to 5000 (0–50%).",
      );
      return;
    }
    // The operator types India time, like every other back-office time.
    const effective = fromOperatorWallTime(effectiveFrom);
    if (!effective) {
      setProposeError("Pick the date and time (IST) the rates take effect.");
      return;
    }
    if (proposeReason.trim().length < 5) {
      setProposeError("Audit reason (at least 5 characters) is required.");
      return;
    }
    propose.mutate({
      marketplaceBps: mkt,
      ownLinkBps: own,
      effectiveFrom: effective.toISOString(),
      reason: proposeReason.trim(),
    });
  };

  const schedules = list.data?.schedules ?? [];
  const active = list.data?.active;

  return (
    <>
      <DashboardHeader
        title="Platform fees"
        subtitle="The take rates every booking is priced with, proposed by one admin and approved by another."
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" /> Fee schedules
            </CardTitle>
            <CardDescription>
              Rates in force now:{" "}
              <strong>
                {active
                  ? `${pct(active.marketplaceBps)} marketplace / ${pct(active.ownLinkBps)} own link`
                  : "—"}
              </strong>
              . A second admin must approve a proposed schedule before it takes
              effect.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {canManage && (
              <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
                <h4 className="text-sm font-semibold">Propose a schedule</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="fee-mkt-bps">Marketplace fee (bps)</Label>
                    <Input
                      id="fee-mkt-bps"
                      type="number"
                      min={0}
                      max={5000}
                      value={marketplaceBps}
                      onChange={(e) => setMarketplaceBps(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="fee-own-bps">Own-link fee (bps)</Label>
                    <Input
                      id="fee-own-bps"
                      type="number"
                      min={0}
                      max={5000}
                      value={ownLinkBps}
                      onChange={(e) => setOwnLinkBps(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="fee-effective-from">
                      Effective from (IST) *
                    </Label>
                    <Input
                      id="fee-effective-from"
                      type="datetime-local"
                      value={effectiveFrom}
                      onChange={(e) => setEffectiveFrom(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="fee-propose-reason">Audit reason *</Label>
                    <Input
                      id="fee-propose-reason"
                      value={proposeReason}
                      onChange={(e) => setProposeReason(e.target.value)}
                      placeholder="Pricing committee approval ref"
                    />
                  </div>
                </div>
                {proposeError && (
                  <p role="alert" className="text-sm text-destructive">
                    {proposeError}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handlePropose}
                    disabled={propose.isPending}
                  >
                    {propose.isPending && (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    )}
                    Propose schedule
                  </Button>
                </div>
              </div>
            )}

            <ResponsiveTable<FeeSchedule>
              columns={COLUMNS}
              rows={schedules}
              getRowId={(s) => s.id}
              isLoading={list.isLoading}
              error={list.isError && !list.data ? list.error : undefined}
              onRetry={() => void list.refetch()}
              rowActions={
                canManage
                  ? (s) =>
                      s.approvedAt ? null : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setApproveTarget(s)}
                        >
                          <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Approve
                        </Button>
                      )
                  : undefined
              }
              empty={
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No schedule proposed yet. The default take rates apply.
                </p>
              }
            />
            <TablePagination
              page={list.data?.page ?? page}
              pageSize={list.data?.limit ?? PAGE_SIZE}
              total={list.data?.total ?? 0}
              onPageChange={setPage}
            />
          </CardContent>
        </Card>
      </DashboardContent>

      {approveTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setApproveTarget(null)}
          title="Approve this fee schedule?"
          description={`${pct(approveTarget.marketplaceBps)} marketplace / ${pct(approveTarget.ownLinkBps)} own link. The admin who proposed it cannot approve it while another admin is active.`}
          confirmLabel="Approve schedule"
          requireReason={{ label: "Checker approval reason" }}
          onConfirm={async ({ reason }) => {
            await callOpsDoor(
              `/api/admin/fee-schedules/${approveTarget.id}/approve`,
              { reason },
            );
            await queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
            setApproveTarget(null);
          }}
        />
      )}
    </>
  );
}
