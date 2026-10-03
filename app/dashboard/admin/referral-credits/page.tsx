"use client";

/**
 * #1839 — Backoffice Referral Credits Screen.
 *
 * - Staff & Admin (`referrals.read`): search by user email, name, user ID, or
 *   referral code; filter by source (`REFERRAL_BONUS`, `REFEREE_BONUS`,
 *   `PROMOTION`, `COMPENSATION`, `MANUAL`) and status (`ACTIVE`, `EXHAUSTED`,
 *   `EXPIRED`, `REVERSED`); inspect credit details and `ReferralCreditUsage`
 *   rows.
 * - Admin only (`referrals.manage`):
 *   1. Issue Goodwill Credit dialog (`userId`, `amountINR` -> `amountPaise`,
 *      `source` = `COMPENSATION` | `MANUAL`, optional `expiresAt`, mandatory
 *      audit `reason`).
 *   2. Reverse Unused Credit action on active credits (`remainingAmount > 0 &&
 *      reversedAt === null`) with mandatory audit `reason`.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Gift,
  Plus,
  RotateCcw,
  Eye,
  Search,
  Loader2,
} from "lucide-react";

import { useSession } from "@/lib/auth-client";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
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
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreditSource =
  | "REFERRAL_BONUS"
  | "REFEREE_BONUS"
  | "PROMOTION"
  | "COMPENSATION"
  | "MANUAL";

export interface CreditUsageItem {
  id: string;
  paymentId: string;
  amount: number;
  originalAmount: number;
  restoredAmount: number;
  createdAt: string;
}

export interface ReferralCreditItem {
  id: string;
  userId: string;
  amount: number;
  usedAmount: number;
  remainingAmount: number;
  currency: string;
  source: CreditSource;
  referralId: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  idempotencyKey: string | null;
  reason: string | null;
  issuedBy: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reversedReason: string | null;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    referralCode?: {
      code: string;
      customCode: string | null;
    } | null;
  };
  usages: CreditUsageItem[];
}

interface CreditsListResponse {
  data: ReferralCreditItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const CREDIT_SOURCES: CreditSource[] = [
  "REFERRAL_BONUS",
  "REFEREE_BONUS",
  "PROMOTION",
  "COMPENSATION",
  "MANUAL",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useCanManageReferrals(): boolean {
  const { data: session } = useSession();
  try {
    const cap = useBackofficeCapability();
    return cap.can("referrals.manage");
  } catch {
    return session?.user?.role === "ADMIN";
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function deriveCreditState(c: ReferralCreditItem): {
  label: string;
  tone: Tone;
} {
  if (c.reversedAt) {
    return { label: "Reversed", tone: "critical" };
  }
  if (c.remainingAmount <= 0) {
    return { label: "Exhausted", tone: "neutral" };
  }
  if (c.expiresAt && new Date(c.expiresAt) <= new Date()) {
    return { label: "Expired", tone: "warning" };
  }
  return { label: "Active", tone: "success" };
}

async function fetchReferralCredits(params: {
  q: string;
  source: string;
  status: string;
  page: number;
}): Promise<CreditsListResponse> {
  const sp = new URLSearchParams();
  if (params.q.trim()) sp.set("q", params.q.trim());
  if (params.source) sp.set("source", params.source);
  if (params.status) sp.set("status", params.status);
  sp.set("page", String(params.page));
  sp.set("limit", "25");

  const res = await fetch(`/api/admin/referrals/credits?${sp.toString()}`);
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(
      (json as { error?: string }).error ?? "Failed to load referral credits",
    );
  }
  return res.json();
}

function parseInrInputToPaise(rawInr: string): number | null {
  const trimmed = rawInr.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [wholePart, fracPart = ""] = trimmed.split(".");
  const rupees = Number.parseInt(wholePart, 10);
  const paise = Number.parseInt(fracPart.padEnd(2, "0"), 10);
  if (!Number.isSafeInteger(rupees) || !Number.isSafeInteger(paise)) {
    return null;
  }
  const totalPaise = rupees * 100 + paise;
  if (!Number.isSafeInteger(totalPaise) || totalPaise <= 0) {
    return null;
  }
  return totalPaise;
}

const REFERRAL_CREDIT_COLUMNS: ResponsiveColumn<ReferralCreditItem>[] = [
  {
    key: "user",
    header: "User",
    primary: true,
    cell: (c) => (
      <div>
        <p className="font-medium text-foreground">
          {c.user.name || c.user.email || c.userId}
        </p>
        {c.user.email && c.user.name && (
          <p className="text-xs text-muted-foreground">{c.user.email}</p>
        )}
        {c.user.referralCode?.code && (
          <p className="text-xs font-mono text-muted-foreground">
            Code: {c.user.referralCode.customCode || c.user.referralCode.code}
          </p>
        )}
      </div>
    ),
  },
  {
    key: "source",
    header: "Source",
    cell: (c) => (
      <Badge variant="outline" className="text-xs">
        {humanizeEnum(c.source)}
      </Badge>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (c) => <StatusBadge {...deriveCreditState(c)} />,
  },
  {
    key: "balance",
    header: "Remaining / Total",
    cell: (c) => (
      <div>
        <span className="font-semibold text-foreground">
          {formatCurrencyAmount(c.remainingAmount, c.currency)}
        </span>{" "}
        <span className="text-xs text-muted-foreground">
          / {formatCurrencyAmount(c.amount, c.currency)}
        </span>
      </div>
    ),
  },
  {
    key: "usages",
    header: "Usages",
    className: "text-sm",
    cell: (c) =>
      c.usages.length > 0 ? (
        <span>
          {c.usages.length} (
          {formatCurrencyAmount(c.usedAmount, c.currency)})
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: "created",
    header: "Issued",
    className: "text-sm text-muted-foreground whitespace-nowrap",
    cell: (c) => fmtDate(c.createdAt),
  },
];

// ---------------------------------------------------------------------------
// Issue Goodwill Credit Dialog (Admin only)
// ---------------------------------------------------------------------------

function IssueGoodwillCreditDialog({
  open,
  onOpenChange,
}: Readonly<{
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState("");
  const [amountINR, setAmountINR] = useState("");
  const [source, setSource] = useState<"COMPENSATION" | "MANUAL">(
    "COMPENSATION",
  );
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setUserId("");
    setAmountINR("");
    setSource("COMPENSATION");
    setExpiresAt("");
    setReason("");
    setIdempotencyKey(crypto.randomUUID());
    setError(null);
  };

  const issueMutation = useMutation({
    mutationFn: async (payload: {
      userId: string;
      amountPaise: number;
      source: "COMPENSATION" | "MANUAL";
      expiresAt: string | null;
      reason: string;
      idempotencyKey: string;
    }) => {
      const res = await fetch("/api/admin/referrals/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ?? "Failed to issue credit",
        );
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-referral-credits"] });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    const trimmedUser = userId.trim();
    if (!trimmedUser) {
      setError("User ID or email is required.");
      return;
    }
    const amountPaise = parseInrInputToPaise(amountINR);
    if (amountPaise === null) {
      setError("Amount (₹) must be a positive number with up to 2 decimal places.");
      return;
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 5) {
      setError("Reason must be at least 5 characters for the audit log.");
      return;
    }
    let expiresIso: string | null = null;
    if (expiresAt.trim()) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime()) || d <= new Date()) {
        setError("Expiry date must be in the future.");
        return;
      }
      expiresIso = d.toISOString();
    }

    issueMutation.mutate({
      userId: trimmedUser,
      amountPaise,
      source,
      expiresAt: expiresIso,
      reason: trimmedReason,
      idempotencyKey,
    });
  };

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <ResponsiveModalContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Issue Goodwill Credit</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="issue-user-id">User ID or email *</Label>
            <Input
              id="issue-user-id"
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                setIdempotencyKey(crypto.randomUUID());
              }}
              placeholder="user_123 or learner@example.com"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="issue-amount-inr">Amount (₹) *</Label>
              <Input
                id="issue-amount-inr"
                type="number"
                min={1}
                step="1"
                value={amountINR}
                onChange={(e) => {
                  setAmountINR(e.target.value);
                  setIdempotencyKey(crypto.randomUUID());
                }}
                placeholder="e.g. 500"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="issue-source">Credit source *</Label>
              <select
                id="issue-source"
                className="flex h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as "COMPENSATION" | "MANUAL");
                  setIdempotencyKey(crypto.randomUUID());
                }}
              >
                <option value="COMPENSATION">Compensation</option>
                <option value="MANUAL">Manual</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="issue-expires-at">Expires on (optional)</Label>
            <Input
              id="issue-expires-at"
              type="date"
              value={expiresAt}
              onChange={(e) => {
                setExpiresAt(e.target.value);
                setIdempotencyKey(crypto.randomUUID());
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="issue-reason">Audit reason *</Label>
            <Input
              id="issue-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ticket #1234 — goodwill credit for missed session"
            />
            <p className="text-xs text-muted-foreground">
              Recorded in OpsActionLog and stamped on the credit row.
            </p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ResponsiveModalFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={issueMutation.isPending}>
            {issueMutation.isPending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Issuing…
              </>
            ) : (
              "Issue credit"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Reverse Unused Credit Dialog (Admin only)
// ---------------------------------------------------------------------------

function ReverseCreditDialog({
  credit,
  open,
  onOpenChange,
}: Readonly<{
  credit: ReferralCreditItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reverseMutation = useMutation({
    mutationFn: async (auditReason: string) => {
      const res = await fetch(
        `/api/admin/referrals/credits/${credit.id}/reverse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: auditReason }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ?? "Failed to reverse credit",
        );
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-referral-credits"] });
      setReason("");
      setError(null);
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleConfirm = () => {
    setError(null);
    const trimmed = reason.trim();
    if (trimmed.length < 5) {
      setError("Reason must be at least 5 characters for the audit log.");
      return;
    }
    reverseMutation.mutate(trimmed);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Reverse Unused Credit</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will zero out the remaining unused balance of{" "}
            <strong className="text-foreground">
              {formatCurrencyAmount(credit.remainingAmount, credit.currency)}
            </strong>{" "}
            for{" "}
            <strong className="text-foreground">
              {credit.user.email || credit.user.name || credit.userId}
            </strong>
            . Any portion already consumed on payments (
            {formatCurrencyAmount(credit.usedAmount, credit.currency)}) remains
            intact.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="reverse-reason">Reversal reason *</Label>
            <Input
              id="reverse-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Duplicate manual grant / abuse clawback"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={reverseMutation.isPending}
          >
            {reverseMutation.isPending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Reversing…
              </>
            ) : (
              "Reverse unused balance"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Credit & Usages Detail Dialog (Staff & Admin)
// ---------------------------------------------------------------------------

function CreditDetailDialog({
  credit,
  open,
  onOpenChange,
}: Readonly<{
  credit: ReferralCreditItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const state = deriveCreditState(credit);
  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Referral credit detail</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <div className="divide-y rounded-md border px-3 text-sm">
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">Status</span>
              <StatusBadge {...state} />
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">User</span>
              <span className="font-medium">
                {credit.user.name || "—"}{" "}
                {credit.user.email ? `(${credit.user.email})` : ""}
              </span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">Source</span>
              <Badge variant="outline">{humanizeEnum(credit.source)}</Badge>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">Granted amount</span>
              <span className="font-medium">
                {formatCurrencyAmount(credit.amount, credit.currency)}
              </span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">Used amount</span>
              <span className="font-medium">
                {formatCurrencyAmount(credit.usedAmount, credit.currency)}
              </span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">Remaining balance</span>
              <span className="font-semibold">
                {formatCurrencyAmount(credit.remainingAmount, credit.currency)}
              </span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">Issued on</span>
              <span>{fmtDate(credit.createdAt)}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">Expires on</span>
              <span>
                {credit.expiresAt ? fmtDate(credit.expiresAt) : "No expiry"}
              </span>
            </div>
            {credit.reason && (
              <div className="flex justify-between gap-4 py-2">
                <span className="text-muted-foreground">Issue reason</span>
                <span className="text-right">{credit.reason}</span>
              </div>
            )}
            {credit.reversedAt && (
              <>
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">Reversed on</span>
                  <span>{fmtDate(credit.reversedAt)}</span>
                </div>
                {credit.reversedReason && (
                  <div className="flex justify-between gap-4 py-2">
                    <span className="text-muted-foreground">
                      Reversal reason
                    </span>
                    <span className="text-right">{credit.reversedReason}</span>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">
              Payment usages ({credit.usages.length})
            </h4>
            {credit.usages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No payment redemptions recorded for this credit.
              </p>
            ) : (
              <div className="divide-y rounded-md border">
                {credit.usages.map((u) => (
                  <div
                    key={u.id}
                    className="flex items-center justify-between px-3 py-2 text-xs"
                  >
                    <div>
                      <p className="font-mono font-medium">
                        Payment: {u.paymentId}
                      </p>
                      <p className="text-muted-foreground">
                        {fmtDate(u.createdAt)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">
                        {formatCurrencyAmount(u.amount, credit.currency)}
                      </p>
                      {u.restoredAmount > 0 && (
                        <p className="text-emerald-600">
                          Restored:{" "}
                          {formatCurrencyAmount(
                            u.restoredAmount,
                            credit.currency,
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AdminReferralCreditsPage() {
  const canManage = useCanManageReferrals();
  const [q, setQ] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);

  const [issueOpen, setIssueOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<ReferralCreditItem | null>(
    null,
  );
  const [reverseTarget, setReverseTarget] =
    useState<ReferralCreditItem | null>(null);

  const creditsQuery = useQuery({
    queryKey: [
      "admin-referral-credits",
      { q, source: sourceFilter, status: statusFilter, page },
    ],
    queryFn: () =>
      fetchReferralCredits({
        q,
        source: sourceFilter,
        status: statusFilter,
        page,
      }),
  });

  const rows = creditsQuery.data?.data ?? [];
  const total = creditsQuery.data?.total ?? 0;
  const totalPages = creditsQuery.data?.totalPages ?? 1;

  const creditSuffix = total === 1 ? "" : "s";
  const creditCountLabel = creditsQuery.isLoading
    ? "Loading…"
    : `${total} credit${creditSuffix}`;

  const renderRowActions = (c: ReferralCreditItem) => {
    const canReverse =
      canManage && c.remainingAmount > 0 && c.reversedAt === null;
    return (
      <div className="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDetailTarget(c)}
          title="Inspect credit & usages"
        >
          <Eye className="mr-1 h-3.5 w-3.5" /> Inspect
        </Button>
        {canReverse && (
          <Button
            size="sm"
            variant="outline"
            className="text-red-600 hover:text-red-700"
            onClick={() => setReverseTarget(c)}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reverse
          </Button>
        )}
      </div>
    );
  };

  const renderCreditsList = () => {
    if (creditsQuery.isLoading) {
      return (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading credits…
        </div>
      );
    }
    if (rows.length === 0) {
      return (
        <div className="py-12 text-center text-muted-foreground">
          <Gift className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm">No referral credits match the filter.</p>
        </div>
      );
    }
    return (
      <>
        <ResponsiveTable<ReferralCreditItem>
          columns={REFERRAL_CREDIT_COLUMNS}
          rows={rows}
          getRowId={(c) => c.id}
          rowActions={renderRowActions}
        />
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <DashboardHeader
        title="Referral Credits"
        subtitle="Inspect referral rewards, promotional balances, and goodwill credits across users."
        actions={
          canManage && (
            <Button size="sm" onClick={() => setIssueOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Issue Goodwill Credit
            </Button>
          )
        }
      />

      <DashboardContent>
        <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">{creditCountLabel}</CardTitle>
                <CardDescription>
                  Staff can inspect balances and payment redemptions. Admins can
                  issue goodwill credits or reverse unused balances.
                </CardDescription>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Search by email, name, or referral code"
                  className="pl-8"
                  placeholder="Search by user email, name, referral code, or ID…"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              <select
                aria-label="Filter by source"
                className="flex h-10 rounded-md border border-border bg-card px-3 py-2 text-sm"
                value={sourceFilter}
                onChange={(e) => {
                  setSourceFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All sources</option>
                {CREDIT_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {humanizeEnum(s)}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filter by status"
                className="flex h-10 rounded-md border border-border bg-card px-3 py-2 text-sm"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="EXHAUSTED">Exhausted</option>
                <option value="EXPIRED">Expired</option>
                <option value="REVERSED">Reversed</option>
              </select>
            </div>
          </CardHeader>

          <CardContent>{renderCreditsList()}</CardContent>
        </Card>
      </DashboardContent>

      {canManage && (
        <IssueGoodwillCreditDialog
          open={issueOpen}
          onOpenChange={setIssueOpen}
        />
      )}

      {detailTarget && (
        <CreditDetailDialog
          credit={detailTarget}
          open={!!detailTarget}
          onOpenChange={(v) => !v && setDetailTarget(null)}
        />
      )}

      {reverseTarget && canManage && (
        <ReverseCreditDialog
          credit={reverseTarget}
          open={!!reverseTarget}
          onOpenChange={(v) => !v && setReverseTarget(null)}
        />
      )}
    </>
  );
}
