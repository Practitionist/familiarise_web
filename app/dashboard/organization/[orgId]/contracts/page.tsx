"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, FileText, Loader2, Check, X } from "lucide-react";
import type { ContractStatus } from "@prisma/client";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContractItem {
  id: string;
  status: ContractStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  paymentTermsDays: number;
  autoRenew: boolean;
  signedAt: string | null;
  createdAt: string;
  billingAccount: {
    id: string;
    fundingSource: string;
    currency: string;
  } | null;
  purchaseOrder: {
    id: string;
    poNumber: string;
    status: string;
  } | null;
  programs: Array<{ id: string; name: string; type: string; status: string }>;
  _count: { programs: number };
}

interface BillingAccount {
  id: string;
  fundingSource: string;
  currency: string;
}

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------

async function fetchContracts(orgId: string): Promise<{ data: ContractItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/contracts`);
  if (!res.ok) throw new Error("Failed to load contracts");
  return res.json();
}

async function fetchBillingAccount(orgId: string): Promise<{ billingAccount: BillingAccount }> {
  const res = await fetch(`/api/organizations/${orgId}/billing-account`);
  if (!res.ok) throw new Error("Failed to load billing account");
  return res.json();
}

async function createContract(
  orgId: string,
  body: {
    billingAccountId: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    paymentTermsDays: number;
    autoRenew: boolean;
    status: "DRAFT" | "ACTIVE";
  },
) {
  const res = await fetch(`/api/organizations/${orgId}/contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? "Failed to create contract");
  }
  return json;
}

async function patchContract(
  orgId: string,
  contractId: string,
  body: { status?: ContractStatus; signedAt?: string | null },
) {
  const res = await fetch(`/api/organizations/${orgId}/contracts/${contractId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? "Failed to update contract");
  }
  return json;
}

async function deleteContract(orgId: string, contractId: string) {
  const res = await fetch(`/api/organizations/${orgId}/contracts/${contractId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error((json as { error?: string }).error ?? "Failed to delete contract");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const STATUS_BADGE: Record<ContractStatus, string> = {
  DRAFT: "bg-zinc-100 text-zinc-700 border-zinc-300",
  ACTIVE: "bg-green-50 text-green-800 border-green-300",
  EXPIRED: "bg-amber-50 text-amber-800 border-amber-300",
  TERMINATED: "bg-red-50 text-red-700 border-red-300",
};

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateContractDialog({
  orgId,
  billingAccountId,
  open,
  onOpenChange,
}: {
  orgId: string;
  billingAccountId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [effectiveTo, setEffectiveTo] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("60");
  const [autoRenew, setAutoRenew] = useState(false);
  const [status, setStatus] = useState<"DRAFT" | "ACTIVE">("ACTIVE");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEffectiveFrom(today);
    setEffectiveTo("");
    setPaymentTermsDays("60");
    setAutoRenew(false);
    setStatus("ACTIVE");
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: (body: Parameters<typeof createContract>[1]) =>
      createContract(orgId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      // Also invalidate the active-contracts cache used by Programs page.
      queryClient.invalidateQueries({ queryKey: ["org-contracts-active", orgId] });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    const terms = parseInt(paymentTermsDays, 10);
    if (!Number.isFinite(terms) || terms < 1 || terms > 120) {
      setError("Payment terms must be between 1 and 120 days.");
      return;
    }
    if (effectiveTo && new Date(effectiveTo) <= new Date(effectiveFrom)) {
      setError("End date must be after the start date.");
      return;
    }
    createMutation.mutate({
      billingAccountId,
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      effectiveTo: effectiveTo ? new Date(effectiveTo).toISOString() : null,
      paymentTermsDays: terms,
      autoRenew,
      status,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Contract</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="effective-from">Effective from *</Label>
              <Input
                id="effective-from"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="effective-to">Effective to</Label>
              <Input
                id="effective-to"
                type="date"
                value={effectiveTo}
                onChange={(e) => setEffectiveTo(e.target.value)}
                placeholder="Open-ended"
              />
              <p className="text-xs text-zinc-500">Leave blank for open-ended</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-terms">Payment terms (days) *</Label>
            <Input
              id="payment-terms"
              type="number"
              min={1}
              max={120}
              value={paymentTermsDays}
              onChange={(e) => setPaymentTermsDays(e.target.value)}
            />
            <p className="text-xs text-zinc-500">
              NET-{paymentTermsDays || "?"} — how many days after invoice date the org must pay.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Initial status</Label>
            <div className="flex gap-2">
              {(["ACTIVE", "DRAFT"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    status === s
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 hover:border-zinc-400"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-500">
              ACTIVE contracts can immediately attach Programs. DRAFT contracts need to be activated first.
            </p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={autoRenew}
              onCheckedChange={(v) => setAutoRenew(v === true)}
            />
            <span className="text-sm">Auto-renew when effective-to date passes</span>
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Creating…
              </>
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrgContractsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { isAtLeast } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    minRole: "MAINTAINER",
    canSponsor: true,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [activateTarget, setActivateTarget] = useState<ContractItem | null>(null);
  const [terminateTarget, setTerminateTarget] = useState<ContractItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ContractItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const contracts = useQuery({
    queryKey: ["org-contracts", orgId],
    queryFn: () => fetchContracts(orgId),
    enabled: allowed,
  });

  const billingAccount = useQuery({
    queryKey: ["org-billing-account", orgId],
    queryFn: () => fetchBillingAccount(orgId),
    enabled: allowed && isAtLeast("OWNER"),
  });

  const patchMutation = useMutation({
    mutationFn: ({
      contractId,
      body,
    }: {
      contractId: string;
      body: { status?: ContractStatus; signedAt?: string | null };
    }) => patchContract(orgId, contractId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      queryClient.invalidateQueries({ queryKey: ["org-contracts-active", orgId] });
      setActivateTarget(null);
      setTerminateTarget(null);
      setActionError(null);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (contractId: string) => deleteContract(orgId, contractId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      queryClient.invalidateQueries({ queryKey: ["org-contracts-active", orgId] });
      setDeleteTarget(null);
      setActionError(null);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  if (!allowed) return null;

  const contractList = contracts.data?.data ?? [];
  const billingAccountId = billingAccount.data?.billingAccount?.id ?? "";
  const canCreate = isAtLeast("OWNER") && !!billingAccountId;

  return (
    <>
      <DashboardHeader
        title="Contracts"
        subtitle="Commercial agreements between your organization and Familiarise. Programs attach to a contract; billing flows from it."
        actions={
          canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> New Contract
            </Button>
          )
        }
      />

      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {contracts.isLoading
                ? "Loading…"
                : `${contractList.length} contract${contractList.length === 1 ? "" : "s"}`}
            </CardTitle>
            <CardDescription>
              ACTIVE contracts accept new Programs. DRAFT contracts need to be
              activated first. Only DRAFT contracts with no attached Programs
              can be deleted — use TERMINATED to close an active one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {contracts.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : contractList.length === 0 ? (
              <div className="text-center py-12 text-zinc-500">
                <FileText className="h-10 w-10 mx-auto mb-3 text-zinc-300" />
                <p className="text-sm">No contracts yet.</p>
                {canCreate && (
                  <p className="text-xs mt-2">
                    Click <strong>New Contract</strong> to create one. Programs
                    and invoices attach to a contract.
                  </p>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Funding</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Terms</TableHead>
                    <TableHead>Programs</TableHead>
                    {isAtLeast("OWNER") && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contractList.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={STATUS_BADGE[c.status]}
                        >
                          {c.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-zinc-600">
                        {c.billingAccount?.fundingSource ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-zinc-600 whitespace-nowrap">
                        {fmtDate(c.effectiveFrom)} →{" "}
                        {c.effectiveTo ? fmtDate(c.effectiveTo) : "open-ended"}
                      </TableCell>
                      <TableCell className="text-sm text-zinc-600">
                        NET-{c.paymentTermsDays}
                        {c.autoRenew && (
                          <span className="ml-1 text-xs text-zinc-400">(auto-renew)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c._count.programs > 0 ? (
                          <span className="text-zinc-700">{c._count.programs}</span>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </TableCell>
                      {isAtLeast("OWNER") && (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {c.status === "DRAFT" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setActionError(null);
                                    setActivateTarget(c);
                                  }}
                                >
                                  <Check className="h-3.5 w-3.5 mr-1" /> Activate
                                </Button>
                                {c._count.programs === 0 && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                    onClick={() => {
                                      setActionError(null);
                                      setDeleteTarget(c);
                                    }}
                                  >
                                    <X className="h-3.5 w-3.5 mr-1" /> Delete
                                  </Button>
                                )}
                              </>
                            )}
                            {c.status === "ACTIVE" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => {
                                  setActionError(null);
                                  setTerminateTarget(c);
                                }}
                              >
                                Terminate
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {actionError && (
              <p className="mt-3 text-sm text-red-600">{actionError}</p>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      {/* Create dialog */}
      {billingAccountId && (
        <CreateContractDialog
          orgId={orgId}
          billingAccountId={billingAccountId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}

      {/* Activate confirmation */}
      <AlertDialog
        open={!!activateTarget}
        onOpenChange={(v) => !v && setActivateTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate contract?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move the contract from DRAFT to ACTIVE. Programs can
              be attached immediately. This action writes an audit log entry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!activateTarget) return;
                patchMutation.mutate({
                  contractId: activateTarget.id,
                  body: {
                    status: "ACTIVE",
                    signedAt: new Date().toISOString(),
                  },
                });
              }}
              disabled={patchMutation.isPending}
            >
              {patchMutation.isPending ? "Activating…" : "Activate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Terminate confirmation */}
      <AlertDialog
        open={!!terminateTarget}
        onOpenChange={(v) => !v && setTerminateTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminate contract?</AlertDialogTitle>
            <AlertDialogDescription>
              Terminating an ACTIVE contract is permanent. Programs with live
              assignments must be cancelled before you can terminate — the
              server will reject this if active assignments exist.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (!terminateTarget) return;
                patchMutation.mutate({
                  contractId: terminateTarget.id,
                  body: { status: "TERMINATED" },
                });
              }}
              disabled={patchMutation.isPending}
            >
              {patchMutation.isPending ? "Terminating…" : "Terminate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete DRAFT contract?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the contract record. Only possible for
              DRAFT contracts with no attached Programs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (!deleteTarget) return;
                deleteMutation.mutate(deleteTarget.id);
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
