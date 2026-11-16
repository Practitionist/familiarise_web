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
import { payoutStatusBadge } from "@/lib/labels/session-labels";
import { formatCurrencyAmount } from "@/utils/formatting";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

interface OrgPayoutRow {
  id: string;
  organizationId: string;
  organization: { name: string; slug: string };
  amountPaise: number;
  currency: string;
  status: string;
  createdAt: string;
  platformApprovalRequiredAt: string | null;
  platformHeldAt: string | null;
}

type Door = "approve" | "hold" | "release";

const STATUSES = [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REVERSED",
];
const QUERY_KEY = ["money-org-payouts"] as const;

const COPY: Record<
  Door,
  { label: string; title: string; description: string; done: string }
> = {
  approve: {
    label: "Approve",
    title: "Co-approve this payout",
    description:
      "The organisation has approved it; your approval lets the next payout run send it. You cannot co-approve a payout you created or approved for the organisation.",
    done: "Payout approved",
  },
  hold: {
    label: "Hold",
    title: "Hold this payout",
    description:
      "A held payout is skipped by every payout run until it is released.",
    done: "Payout held",
  },
  release: {
    label: "Release",
    title: "Release this payout",
    description: "The next payout run may send it once it is approved.",
    done: "Payout released",
  },
};

function doorsFor(r: OrgPayoutRow): Door[] {
  if (r.platformHeldAt) return ["release"];
  const doors: Door[] = [];
  if (r.status === "PENDING" && r.platformApprovalRequiredAt) {
    doors.push("approve");
  }
  if (r.status === "PENDING" || r.status === "APPROVED") doors.push("hold");
  return doors;
}

async function fetchOrgPayouts(filters: Record<string, string>) {
  const params = new URLSearchParams({ limit: "50", ...filters });
  const res = await fetch(`/api/admin/org-payouts?${params}`);
  if (!res.ok) throw new Error("Failed to load organisation payouts");
  return (await res.json()) as { payouts: OrgPayoutRow[] };
}

const columns: ResponsiveColumn<OrgPayoutRow>[] = [
  {
    key: "org",
    header: "Organisation",
    primary: true,
    cell: (r) => <p className="text-sm font-medium">{r.organization.name}</p>,
  },
  {
    key: "payoutId",
    header: "Payout ID",
    cell: (r) => (
      <span
        data-copyable=""
        className="font-mono text-xs text-muted-foreground"
        title={r.id}
      >
        {r.id.slice(-8).toUpperCase()}
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    cell: (r) => formatCurrencyAmount(r.amountPaise, r.currency),
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => (
      <div className="flex flex-wrap gap-1">
        <StatusBadge {...payoutStatusBadge(r.status)} />
        {r.status === "PENDING" && r.platformApprovalRequiredAt && (
          <StatusBadge label="Needs platform approval" tone="caution" />
        )}
        {r.platformHeldAt && <StatusBadge label="Held" tone="critical" />}
      </div>
    ),
  },
  {
    key: "created",
    header: "Created",
    cell: (r) => new Date(r.createdAt).toLocaleString(),
  },
];

type Acting = { row: OrgPayoutRow; door: Door };

/** Row actions built outside render, so the table never remounts them. */
function payoutActions(onAct: (acting: Acting) => void) {
  return function OrgPayoutAction(r: OrgPayoutRow) {
    const doors = doorsFor(r);
    return doors.length > 0 ? (
      <div className="flex gap-2">
        {doors.map((door) => (
          <Button
            key={door}
            size="sm"
            variant="outline"
            onClick={() => onAct({ row: r, door })}
          >
            {COPY[door].label}
          </Button>
        ))}
      </div>
    ) : null;
  };
}

/** Org payouts: co-approve the large or recently re-routed ones, and hold or release any not yet sent. */
export function OrgPayoutsTab() {
  const [status, setStatus] = useState("PENDING");
  const [orgId, setOrgId] = useState("");
  const [acting, setActing] = useState<Acting | null>(null);
  const rowActions = useMemo(() => payoutActions(setActing), []);

  const filters: Record<string, string> = {
    ...(status === "all" ? {} : { status }),
    ...(orgId.trim() ? { orgId: orgId.trim() } : {}),
  };
  const { data, isLoading, error } = useQuery({
    queryKey: [...QUERY_KEY, filters],
    queryFn: () => fetchOrgPayouts(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const door = useOpsDoor({
    success: acting ? COPY[acting.door].done : "Done",
    invalidate: [QUERY_KEY],
    onDone: () => setActing(null),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Org payouts"
        description="Payouts above ₹50,000, or minted within 7 days of a payout-account change, wait here for a platform co-approval after the organisation approves them."
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
                    label: payoutStatusBadge(s).label,
                  })),
                ],
                onChange: setStatus,
              },
            ]}
          >
            <Input
              className="h-9 w-48"
              aria-label="Organisation id"
              placeholder="Organisation id"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
            />
          </FilterBar>
          {error ? (
            <p className="text-sm text-destructive">
              Organisation payouts could not load.
            </p>
          ) : (
            <ResponsiveTable<OrgPayoutRow>
              columns={columns}
              rows={isLoading ? [] : (data?.payouts ?? [])}
              getRowId={(r) => r.id}
              rowActions={rowActions}
              empty={
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {isLoading ? "Loading…" : "No payouts match these filters."}
                </p>
              }
            />
          )}
        </CardContent>
        <ReasonDialog
          open={acting !== null}
          onOpenChange={(o) => !o && setActing(null)}
          title={acting ? COPY[acting.door].title : ""}
          description={acting ? COPY[acting.door].description : ""}
          confirmLabel={acting ? COPY[acting.door].label : ""}
          pending={door.isPending}
          onConfirm={(reason) =>
            acting &&
            door.mutate({
              url: `/api/admin/org-payouts/${acting.row.id}/${acting.door}`,
              body: { reason },
            })
          }
        />
      </Card>
    </div>
  );
}
