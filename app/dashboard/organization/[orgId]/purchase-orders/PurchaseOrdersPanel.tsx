"use client";

/**
 * Purchase orders — a Billing tab since #1527 Q7 (India AP 3-way match).
 *
 * Thin orchestrator: state for filters + dialog open/close, plus the list
 * query. UI primitives live in `./components/*`, helpers in `./utils/*`. The
 * Billing page shows this tab for `purchaseOrders.read` on a sponsor org, so
 * POs can be created before `requiresPO` is switched on (the flag only makes
 * them mandatory on contracts and invoices); the server stays authoritative.
 */

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plus } from "lucide-react";

import { useOrgRole } from "../useOrgRole";
import { rolesHoldingLabel } from "@/lib/labels/org-labels";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { CreatePurchaseOrderDialog } from "./components/CreatePurchaseOrderDialog";
import { EditPurchaseOrderDialog } from "./components/EditPurchaseOrderDialog";
import { DeletePurchaseOrderDialog } from "./components/DeletePurchaseOrderDialog";
import {
  PurchaseOrderStatCards,
  type PurchaseOrderStats,
} from "./components/PurchaseOrderStatCards";
import { PurchaseOrdersTable } from "./components/PurchaseOrdersTable";
import { fetchPurchaseOrders } from "./utils/api";
import { PO_STATUS, PO_STATUSES } from "./utils/formatting";
import type { PoStatus, PurchaseOrderRow } from "./utils/types";

const STATUS_OPTIONS = [
  { value: "ALL", label: "All statuses" },
  ...PO_STATUSES.map((value) => ({ value, label: PO_STATUS[value].label })),
];

export function PurchaseOrdersPanel({ orgId }: Readonly<{ orgId: string }>) {
  // #1132 — PO mutations are `purchaseOrders.manage` (OWNER + BILLING_ADMIN).
  const { can } = useOrgRole(orgId);

  const [statusFilter, setStatusFilter] = useState<PoStatus | "ALL">("ALL");
  const [searchTerm, setSearchTerm] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PurchaseOrderRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PurchaseOrderRow | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["org-purchase-orders", orgId, statusFilter],
    // Filter/page live in the key, so each value is its own query. Without
    // this, switching to one not yet fetched dropped `data` to undefined and
    // re-showed the loading branch. Same fix as #346 on the appointments list.
    placeholderData: keepPreviousData,
    queryFn: () => fetchPurchaseOrders(orgId, statusFilter),
  });

  // BILLING_ADMIN gate is enforced server-side; the client check uses
  // MAINTAINER-or-higher so OWNER and BILLING_ADMIN both pass without
  // the page reaching into the disjunction rules. A MANAGER session
  // never sees the affordances.
  const canMutate = can("purchaseOrders.manage");

  const rows = useMemo(() => {
    const data = list.data?.data ?? [];
    if (!searchTerm.trim()) return data;
    const needle = searchTerm.trim().toLowerCase();
    return data.filter((po) => po.poNumber.toLowerCase().includes(needle));
  }, [list.data, searchTerm]);

  const nearExhaustedPos = useMemo(() => {
    const data = list.data?.data ?? [];
    return data.filter(
      (po) =>
        po.status === "ACTIVE" &&
        po.totalAmountPaise > 0 &&
        (po.totalAmountPaise - po.remainingAmountPaise) / po.totalAmountPaise >=
          0.8,
    );
  }, [list.data]);

  const stats: PurchaseOrderStats = useMemo(() => {
    const data = list.data?.data ?? [];
    let activeCount = 0;
    let totalCommittedINR = 0;
    let totalRemainingINR = 0;
    for (const po of data) {
      if (po.status === "ACTIVE") {
        activeCount += 1;
        // Forex POs excluded from rollup — mixing currencies in a single
        // sum is misleading. The stat-card labels say "(INR only)".
        if (po.currency === "INR") {
          totalCommittedINR += po.totalAmountPaise;
          totalRemainingINR += po.remainingAmountPaise;
        }
      }
    }
    return {
      total: data.length,
      activeCount,
      totalCommittedINR,
      totalRemainingINR,
    };
  }, [list.data]);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Purchase orders back contracts and invoices.{" "}
          {canMutate
            ? "Cancel one to retire it once it is no longer in use."
            : `You can view them here; adding, editing or cancelling one needs the ${rolesHoldingLabel("purchaseOrders.manage")} role.`}
        </p>
        {canMutate && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New PO
          </Button>
        )}
      </div>
      {nearExhaustedPos.length > 0 && (
        <output className="flex items-start gap-2.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-medium">
              {nearExhaustedPos.length === 1
                ? `Purchase order ${nearExhaustedPos[0].poNumber} is at or above 80% consumption`
                : `${nearExhaustedPos.length} active purchase orders are at or above 80% consumption`}
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300">
              Issue a replacement or supplemental PO with your AP team before
              remaining committed balance runs out.
            </p>
          </div>
        </output>
      )}
      <PurchaseOrderStatCards stats={stats} />

      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                {list.isLoading
                  ? "Loading…"
                  : `${rows.length} purchase order${rows.length === 1 ? "" : "s"}`}
              </CardTitle>
              <CardDescription>
                PO numbers come from your accounts payable team, and each can be
                used once in this organization.
                {canMutate &&
                  " A PO linked to a contract or invoice can be cancelled, not deleted."}
              </CardDescription>
            </div>
            <FilterBar
              className="md:min-w-[22rem]"
              search={{
                label: "Search PO number",
                placeholder: "Search PO number…",
                value: searchTerm,
                onChange: setSearchTerm,
              }}
              selects={[
                {
                  key: "status",
                  label: "Filter by status",
                  value: statusFilter,
                  options: STATUS_OPTIONS,
                  onChange: (v) =>
                    setStatusFilter(PO_STATUSES.find((s) => s === v) ?? "ALL"),
                },
              ]}
              onClear={() => {
                setSearchTerm("");
                setStatusFilter("ALL");
              }}
              canClear={statusFilter !== "ALL" || searchTerm.trim() !== ""}
            />
          </div>
        </CardHeader>
        <CardContent>
          <PurchaseOrdersTable
            rows={rows}
            isLoading={list.isLoading}
            isError={list.isError}
            canMutate={canMutate}
            searchTerm={searchTerm}
            statusFilter={statusFilter}
            onEdit={(po) => {
              setActionError(null);
              setEditTarget(po);
            }}
            onDelete={(po) => {
              setActionError(null);
              setDeleteTarget(po);
            }}
          />
          {actionError && (
            <p className="mt-3 text-sm text-red-600">{actionError}</p>
          )}
        </CardContent>
      </Card>

      <CreatePurchaseOrderDialog
        orgId={orgId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <EditPurchaseOrderDialog
        orgId={orgId}
        po={editTarget}
        open={!!editTarget}
        onOpenChange={(v) => {
          if (!v) setEditTarget(null);
        }}
      />

      <DeletePurchaseOrderDialog
        orgId={orgId}
        po={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onError={(msg) => setActionError(msg)}
      />
    </>
  );
}
