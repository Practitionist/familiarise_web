"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { earningStatusBadge } from "@/lib/labels/session-labels";
import { formatCurrencyAmount } from "@/utils/formatting";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

interface EarningRow {
  id: string;
  paymentId: string;
  consultantProfileId: string;
  consultantSharePaise: number;
  status: string;
  holdUntil: string | null;
  consultantProfile: { user: { name: string; email: string } };
}

const STATUSES = ["PENDING", "READY", "HELD", "BATCHED", "PAID", "REFUNDED"];
const QUERY_KEY = ["money-earnings"] as const;

function doorFor(status: string): "hold" | "release" | null {
  if (status === "HELD") return "release";
  if (status === "PENDING" || status === "READY") return "hold";
  return null;
}

async function fetchEarnings(filters: Record<string, string>) {
  const params = new URLSearchParams({ limit: "50", ...filters });
  const res = await fetch(`/api/admin/earnings?${params}`);
  if (!res.ok) throw new Error("Failed to load earnings");
  return (await res.json()) as { earnings: EarningRow[] };
}

const columns: ResponsiveColumn<EarningRow>[] = [
  {
    key: "consultant",
    header: "Consultant",
    primary: true,
    cell: (r) => (
      <div>
        <p className="text-sm font-medium">{r.consultantProfile.user.name}</p>
        <p className="text-xs text-muted-foreground">{r.paymentId}</p>
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
    cell: (r) => earningStatusBadge(r.status).label,
  },
  {
    key: "hold",
    header: "Hold until",
    cell: (r) =>
      r.holdUntil ? new Date(r.holdUntil).toLocaleString() : "Not set",
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
  const [status, setStatus] = useState("all");
  const [consultantProfileId, setConsultantProfileId] = useState("");
  const [paymentId, setPaymentId] = useState("");
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
    queryKey: [...QUERY_KEY, filters],
    queryFn: () => fetchEarnings(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const door = useOpsDoor({
    success: acting?.kind === "hold" ? "Earning held" : "Earning released",
    invalidate: [QUERY_KEY],
    onDone: () => setActing(null),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Earnings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every status</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {earningStatusBadge(s).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Consultant profile id"
            placeholder="Consultant profile id"
            value={consultantProfileId}
            onChange={(e) => setConsultantProfileId(e.target.value)}
          />
          <Input
            aria-label="Payment id"
            placeholder="Payment id"
            value={paymentId}
            onChange={(e) => setPaymentId(e.target.value)}
          />
        </div>
        {error ? (
          <p className="text-sm text-destructive">Earnings could not load.</p>
        ) : (
          <ResponsiveTable<EarningRow>
            columns={columns}
            rows={isLoading ? [] : (data?.earnings ?? [])}
            getRowId={(r) => r.id}
            rowActions={rowActions}
            empty={
              <p className="py-8 text-center text-sm text-muted-foreground">
                {isLoading ? "Loading…" : "No earnings match these filters."}
              </p>
            }
          />
        )}
      </CardContent>
      <ReasonDialog
        open={acting !== null}
        onOpenChange={(o) => !o && setActing(null)}
        title={
          acting?.kind === "hold" ? "Hold this earning" : "Release this earning"
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
  );
}
