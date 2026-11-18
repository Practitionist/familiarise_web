"use client";

import { useEffect, useState } from "react";
import { countLabel } from "@/lib/ui/count-label";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye,
  Gift,
  Loader2,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
} from "lucide-react";

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import {
  FilterBar,
  type FilterBarProps,
} from "@/components/dashboard/FilterBar";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { pagedListFilters } from "@/components/dashboard/shared/paged-list-filters";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Badge } from "@/components/ui/badge";
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
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
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
import { formatCurrencyAmount } from "@/utils/formatting";
import { formatOperatorInstant } from "@/lib/time/operator-zone";
import { HeldReferralsPanel } from "./HeldReferralsPanel";

const CREDIT_SOURCES = [
  "REFERRAL_BONUS",
  "REFEREE_BONUS",
  "PROMOTION",
  "COMPENSATION",
  "MANUAL",
] as const;

type CreditSourceType = (typeof CREDIT_SOURCES)[number];
type ReferralCreditStateType = "PENDING" | "VESTED" | "EXPIRED" | "VOID";

interface CreditUsageItem {
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
  source: CreditSourceType;
  state?: ReferralCreditStateType;
  referralId: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  vestedAt?: string | null;
  voidedAt?: string | null;
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
    referralCode: {
      code: string;
      customCode: string | null;
    } | null;
  };
  usages: CreditUsageItem[];
}

interface CreditsResponse {
  data: ReferralCreditItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface FeeWaiverItem {
  id: string;
  consultantProfileId: string;
  reason: "REFERRED_EXPERT" | "REFERRING_EXPERT" | "FOUNDING_EXPERT";
  sessionsRemaining: number;
  expiresAt: string;
  referralId: string | null;
  createdAt: string;
  consultantProfile: {
    id: string;
    userId: string;
    user: {
      id: string;
      name: string | null;
      email: string | null;
    };
  };
  referral: {
    id: string;
    status: string;
    configVersion: number | null;
  } | null;
}

interface WaiversResponse {
  data: FeeWaiverItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ReferralProgramConfigData {
  id: string;
  isActive: boolean;
  paused: boolean;
  monthlyBudgetPaise: number;
  currentPeriod: string;
  currentMonthSpentPaise: number;
  referrerRewardPaise: number;
  discountBps: number;
  discountMaxPaise: number;
  redemptionCapBps: number;
  minOrderPaise: number;
  creditExpiryDays: number;
  qualifyWindowDays: number;
  perCodeLifetimeCap: number;
  perReferrerYearlyCapPaise: number;
  weeklyVestCap: number;
  expertYearlyReferralCap: number;
  expertWaiverSessions: number;
  expertWaiverDays: number;
  expertReferralBudgetPaise: number;
  version: number;
}

const fmtDate = (d: string | null): string =>
  d ? formatOperatorInstant(d, "date") : "—";

function humanizeEnum(val: string): string {
  return val
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parseInrToPaise(raw: string, allowZero: boolean): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [rupeesPart, decimalsPart = ""] = trimmed.split(".");
  const rupees = Number(rupeesPart);
  const paise = Number(decimalsPart.padEnd(2, "0"));
  if (!Number.isSafeInteger(rupees) || !Number.isSafeInteger(paise)) {
    return null;
  }
  const totalPaise = rupees * 100 + paise;
  const minAllowed = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(totalPaise) || totalPaise < minAllowed) {
    return null;
  }
  return totalPaise;
}

function parseInrInputToPaise(raw: string): number | null {
  return parseInrToPaise(raw, false);
}

function parseNonNegativeInrToPaise(raw: string): number | null {
  return parseInrToPaise(raw, true);
}

/** A credit's state in words, for the badge and the page's subtitle. */
const CREDIT_STATE_LABEL = {
  PENDING: "Pending",
  VESTED: "Available",
  EXPIRED: "Expired",
  VOID: "Void",
  EXHAUSTED: "Used up",
} as const;

export function deriveCreditState(c: ReferralCreditItem): {
  label: string;
  status: string;
  tone: "success" | "warning" | "critical" | "neutral";
} {
  if (c.reversedAt || c.state === "VOID") {
    return { label: CREDIT_STATE_LABEL.VOID, status: "VOID", tone: "critical" };
  }
  if (c.state === "PENDING") {
    return {
      label: CREDIT_STATE_LABEL.PENDING,
      status: "PENDING",
      tone: "warning",
    };
  }
  if (
    c.state === "EXPIRED" ||
    (c.expiresAt &&
      new Date(c.expiresAt) <= new Date() &&
      c.remainingAmount > 0)
  ) {
    return {
      label: CREDIT_STATE_LABEL.EXPIRED,
      status: "EXPIRED",
      tone: "warning",
    };
  }
  if (c.remainingAmount <= 0) {
    return {
      label: CREDIT_STATE_LABEL.EXHAUSTED,
      status: "EXHAUSTED",
      tone: "neutral",
    };
  }
  const st = c.state ?? "VESTED";
  return { label: CREDIT_STATE_LABEL[st], status: st, tone: "success" };
}

function deriveWaiverState(w: FeeWaiverItem): {
  label: string;
  tone: "success" | "warning" | "neutral";
} {
  if (w.sessionsRemaining <= 0) {
    return { label: "EXHAUSTED", tone: "neutral" };
  }
  if (new Date(w.expiresAt) <= new Date()) {
    return { label: "EXPIRED", tone: "warning" };
  }
  return { label: "ACTIVE", tone: "success" };
}

async function fetchReferralCredits(params: {
  q: string;
  source: string;
  status: string;
  page: number;
}): Promise<CreditsResponse> {
  const sp = new URLSearchParams();
  if (params.q.trim()) sp.set("q", params.q.trim());
  if (params.source && params.source !== "ALL") sp.set("source", params.source);
  if (params.status && params.status !== "ALL") sp.set("status", params.status);
  sp.set("page", String(params.page));
  sp.set("limit", "25");

  const res = await fetch(`/api/admin/referrals/credits?${sp.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? "Failed to load referral credits",
    );
  }
  return res.json();
}

async function fetchFeeWaivers(params: {
  q: string;
  status: string;
  reason: string;
  page: number;
}): Promise<WaiversResponse> {
  const sp = new URLSearchParams();
  if (params.q.trim()) sp.set("q", params.q.trim());
  if (params.status && params.status !== "ALL") sp.set("status", params.status);
  if (params.reason && params.reason !== "ALL") sp.set("reason", params.reason);
  sp.set("page", String(params.page));
  sp.set("limit", "25");

  const res = await fetch(`/api/admin/referrals/waivers?${sp.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? "Failed to load fee waivers",
    );
  }
  return res.json();
}

const REFERRAL_CREDIT_COLUMNS: ResponsiveColumn<ReferralCreditItem>[] = [
  {
    key: "user",
    header: "User",
    primary: true,
    cell: (c) => (
      <div className="min-w-0">
        <p className="truncate font-medium">{c.user.name || "Unnamed user"}</p>
        <p className="truncate text-xs text-muted-foreground">
          {c.user.email || c.userId}
        </p>
      </div>
    ),
  },
  {
    key: "source",
    header: "Source",
    cell: (c) => (
      <div className="space-y-0.5">
        <Badge variant="outline" className="text-[11px] font-normal">
          {humanizeEnum(c.source)}
        </Badge>
        {c.user.referralCode && (
          <p className="font-mono text-[11px] text-muted-foreground">
            Code: {c.user.referralCode.customCode || c.user.referralCode.code}
          </p>
        )}
      </div>
    ),
  },
  {
    key: "amount",
    header: "Granted",
    className: "text-right",
    headClassName: "text-right",
    cell: (c) => (
      <span className="font-medium tabular-nums">
        {formatCurrencyAmount(c.amount, c.currency)}
      </span>
    ),
  },
  {
    key: "used",
    header: "Used",
    className: "text-right",
    headClassName: "text-right",
    cell: (c) => (
      <span className="tabular-nums text-muted-foreground">
        {formatCurrencyAmount(c.usedAmount, c.currency)}
      </span>
    ),
  },
  {
    key: "remaining",
    header: "Remaining",
    className: "text-right",
    headClassName: "text-right",
    cell: (c) => (
      <span className="font-semibold tabular-nums">
        {formatCurrencyAmount(c.remainingAmount, c.currency)}
      </span>
    ),
  },
  {
    key: "state",
    header: "State",
    cell: (c) => <StatusBadge {...deriveCreditState(c)} />,
  },
  {
    key: "expiresAt",
    header: "Expires",
    cell: (c) => (
      <span className="text-xs text-muted-foreground">
        {c.expiresAt ? fmtDate(c.expiresAt) : "No expiry"}
      </span>
    ),
  },
  {
    key: "createdAt",
    header: "Issued",
    cell: (c) => (
      <span className="text-xs text-muted-foreground">
        {fmtDate(c.createdAt)}
      </span>
    ),
  },
];

const FEE_WAIVER_COLUMNS: ResponsiveColumn<FeeWaiverItem>[] = [
  {
    key: "consultant",
    header: "Consultant",
    primary: true,
    cell: (w) => (
      <div className="min-w-0">
        <p className="truncate font-medium">
          {w.consultantProfile.user.name || "Unnamed consultant"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {w.consultantProfile.user.email || w.consultantProfile.userId}
        </p>
      </div>
    ),
  },
  {
    key: "reason",
    header: "Reason",
    cell: (w) => (
      <Badge variant="outline" className="text-[11px] font-normal">
        {humanizeEnum(w.reason)}
      </Badge>
    ),
  },
  {
    key: "sessionsRemaining",
    header: "Fee-free sessions",
    cell: (w) => (
      <span className="font-semibold tabular-nums">
        {w.sessionsRemaining} fee-free sessions left · expires{" "}
        {fmtDate(w.expiresAt)}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (w) => <StatusBadge {...deriveWaiverState(w)} />,
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
  const [hasUncertainFailure, setHasUncertainFailure] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rotateKeyIfCertain = () => {
    if (!hasUncertainFailure) {
      setIdempotencyKey(crypto.randomUUID());
    }
  };

  const reset = () => {
    setUserId("");
    setAmountINR("");
    setSource("COMPENSATION");
    setExpiresAt("");
    setReason("");
    setHasUncertainFailure(false);
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
      let res: Response;
      try {
        res = await fetch("/api/admin/referrals/credits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (networkErr) {
        setHasUncertainFailure(true);
        throw networkErr;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status >= 500) {
          setHasUncertainFailure(true);
        } else {
          setHasUncertainFailure(false);
          setIdempotencyKey(crypto.randomUUID());
        }
        throw new Error(
          (json as { error?: string }).error ?? "Failed to issue credit",
        );
      }
      setHasUncertainFailure(false);
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
      setError(
        "Amount (₹) must be a positive number with up to 2 decimal places.",
      );
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
                rotateKeyIfCertain();
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
                  rotateKeyIfCertain();
                }}
                placeholder="e.g. 500"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="issue-source">Credit source *</Label>
              <Select
                value={source}
                onValueChange={(val) => {
                  if (val === "COMPENSATION" || val === "MANUAL") {
                    setSource(val);
                    rotateKeyIfCertain();
                  }
                }}
              >
                <SelectTrigger id="issue-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="COMPENSATION">Compensation</SelectItem>
                  <SelectItem value="MANUAL">Manual</SelectItem>
                </SelectContent>
              </Select>
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
                rotateKeyIfCertain();
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="issue-reason">Audit reason *</Label>
            <Input
              id="issue-reason"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                rotateKeyIfCertain();
              }}
              placeholder="Support case reference — goodwill credit for missed session"
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
              <span className="text-muted-foreground">State</span>
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
// Grant / Revoke Fee Waiver Dialogs (Admin only)
// ---------------------------------------------------------------------------

function GrantFeeWaiverDialog({
  open,
  onOpenChange,
}: Readonly<{
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const [consultantUserId, setConsultantUserId] = useState("");
  const [waiverReason, setWaiverReason] = useState<
    "REFERRED_EXPERT" | "REFERRING_EXPERT"
  >("REFERRED_EXPERT");
  const [sessionsGranted, setSessionsGranted] = useState("3");
  const [expiresAt, setExpiresAt] = useState("");
  const [auditReason, setAuditReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setConsultantUserId("");
    setWaiverReason("REFERRED_EXPERT");
    setSessionsGranted("3");
    setExpiresAt("");
    setAuditReason("");
    setError(null);
  };

  const grantMutation = useMutation({
    mutationFn: async (payload: {
      action: "GRANT";
      consultantUserId: string;
      waiverReason: "REFERRED_EXPERT" | "REFERRING_EXPERT";
      sessionsGranted: number;
      expiresAt?: string;
      reason: string;
    }) => {
      const res = await fetch("/api/admin/referrals/waivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ?? "Failed to grant fee waiver",
        );
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-fee-waivers"] });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    const trimmedTarget = consultantUserId.trim();
    if (!trimmedTarget) {
      setError("Consultant email, user ID, or profile ID is required.");
      return;
    }
    const sessions = Number.parseInt(sessionsGranted, 10);
    if (!Number.isInteger(sessions) || sessions < 1 || sessions > 50) {
      setError("Sessions granted must be between 1 and 50.");
      return;
    }
    const trimmedReason = auditReason.trim();
    if (trimmedReason.length < 5) {
      setError("Audit reason must be at least 5 characters.");
      return;
    }
    let expiresIso: string | undefined;
    if (expiresAt.trim()) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime()) || d <= new Date()) {
        setError("Expiry date must be in the future.");
        return;
      }
      expiresIso = d.toISOString();
    }

    grantMutation.mutate({
      action: "GRANT",
      consultantUserId: trimmedTarget,
      waiverReason,
      sessionsGranted: sessions,
      expiresAt: expiresIso,
      reason: trimmedReason,
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
      <ResponsiveModalContent className="sm:max-w-md">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>
            Grant Consultant Fee Waiver
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="waiver-consultant">
              Consultant email, user ID, or profile ID *
            </Label>
            <Input
              id="waiver-consultant"
              value={consultantUserId}
              onChange={(e) => setConsultantUserId(e.target.value)}
              placeholder="expert@example.com or user_123"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="waiver-sessions">Sessions granted *</Label>
              <Input
                id="waiver-sessions"
                type="number"
                min={1}
                max={50}
                value={sessionsGranted}
                onChange={(e) => setSessionsGranted(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="waiver-reason-kind">Waiver reason *</Label>
              <Select
                value={waiverReason}
                onValueChange={(val) => {
                  if (val === "REFERRED_EXPERT" || val === "REFERRING_EXPERT") {
                    setWaiverReason(val);
                  }
                }}
              >
                <SelectTrigger id="waiver-reason-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="REFERRED_EXPERT">
                    Referred Expert
                  </SelectItem>
                  <SelectItem value="REFERRING_EXPERT">
                    Referring Expert
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="waiver-expires">Expires on (optional)</Label>
            <Input
              id="waiver-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="waiver-audit-reason">Audit reason *</Label>
            <Input
              id="waiver-audit-reason"
              value={auditReason}
              onChange={(e) => setAuditReason(e.target.value)}
              placeholder="Manual fee waiver grant for expert onboarding"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={grantMutation.isPending}>
            {grantMutation.isPending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Granting…
              </>
            ) : (
              "Grant waiver"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

function RevokeFeeWaiverDialog({
  waiver,
  open,
  onOpenChange,
}: Readonly<{
  waiver: FeeWaiverItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const revokeMutation = useMutation({
    mutationFn: async (auditReason: string) => {
      const res = await fetch("/api/admin/referrals/waivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "REVOKE",
          waiverId: waiver.id,
          reason: auditReason,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ?? "Failed to revoke fee waiver",
        );
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-fee-waivers"] });
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
      setError("Audit reason must be at least 5 characters.");
      return;
    }
    revokeMutation.mutate(trimmed);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Revoke Fee Waiver</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will zero out the remaining{" "}
            <strong className="text-foreground">
              {waiver.sessionsRemaining} waived sessions
            </strong>{" "}
            for{" "}
            <strong className="text-foreground">
              {waiver.consultantProfile.user.email ||
                waiver.consultantProfile.user.name ||
                waiver.consultantProfile.userId}
            </strong>
            .
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="revoke-waiver-reason">Revocation reason *</Label>
            <Input
              id="revoke-waiver-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Disqualified referral / manual revocation"
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
            disabled={revokeMutation.isPending}
          >
            {revokeMutation.isPending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Revoking…
              </>
            ) : (
              "Revoke waiver"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Shared List Card for Credits & Fee Waivers
// ---------------------------------------------------------------------------

function ReferralsListCard<T extends { id: string }>({
  title,
  description,
  actionLabel,
  onAction,
  filters,
  isLoading,
  error,
  onRetry,
  loadingLabel,
  emptyIcon: EmptyIcon,
  emptyMessage,
  columns,
  rows,
  rowActions,
  page,
  totalPages,
  onPageChange,
}: Readonly<{
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  filters: FilterBarProps;
  isLoading: boolean;
  /** A failed load: shown in place of the list, never as an empty one. */
  error: Error | null;
  onRetry: () => void;
  loadingLabel: string;
  emptyIcon: typeof Gift;
  emptyMessage: string;
  columns: ResponsiveColumn<T>[];
  rows: T[];
  rowActions?: (item: T) => React.ReactNode;
  page: number;
  totalPages: number;
  onPageChange: (updater: (prev: number) => number) => void;
}>) {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {actionLabel && onAction && (
            <Button size="sm" onClick={onAction}>
              <Plus className="mr-1 h-4 w-4" /> {actionLabel}
            </Button>
          )}
        </div>

        <FilterBar {...filters} />
      </CardHeader>

      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {loadingLabel}
          </div>
        )}
        {!isLoading && error && (
          <p role="alert" className="py-8 text-center text-sm text-destructive">
            {error.message}{" "}
            <button type="button" className="underline" onClick={onRetry}>
              Retry
            </button>
          </p>
        )}
        {!isLoading && !error && rows.length === 0 && (
          <div className="py-12 text-center text-muted-foreground">
            <EmptyIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm">{emptyMessage}</p>
          </div>
        )}
        {!isLoading && !error && rows.length > 0 && (
          <>
            <ResponsiveTable<T>
              columns={columns}
              rows={rows}
              getRowId={(r) => r.id}
              rowActions={rowActions}
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
                    onClick={() => onPageChange((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages}
                    onClick={() =>
                      onPageChange((p) => Math.min(totalPages, p + 1))
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: Credits Panel
// ---------------------------------------------------------------------------

function CreditsTabPanel({
  canManage,
}: Readonly<{
  canManage: boolean;
}>) {
  const [q, setQ] = useState("");
  const [sourceFilter, setSourceFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);

  const [detailTarget, setDetailTarget] = useState<ReferralCreditItem | null>(
    null,
  );
  const [reverseTarget, setReverseTarget] = useState<ReferralCreditItem | null>(
    null,
  );

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
  const creditCountLabel = countLabel(
    { loading: creditsQuery.isLoading, failed: creditsQuery.isError },
    total,
    () => `${total} credit${creditSuffix}`,
    "Credits couldn't be loaded",
  );

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

  return (
    <>
      <ReferralsListCard<ReferralCreditItem>
        title={creditCountLabel}
        description={`Inspect referral credit states (${[
          CREDIT_STATE_LABEL.PENDING,
          CREDIT_STATE_LABEL.VESTED,
          CREDIT_STATE_LABEL.EXPIRED,
          CREDIT_STATE_LABEL.VOID,
        ].join(", ")}), balances, and payment redemptions.`}
        filters={pagedListFilters({
          search: {
            label: "Search by email, name, or referral code",
            placeholder: "Search by user email, name, referral code, or ID…",
            value: q,
            onChange: setQ,
          },
          selects: [
            {
              key: "source",
              label: "Filter by source",
              value: sourceFilter,
              onChange: setSourceFilter,
              options: [
                { value: "ALL", label: "All sources" },
                ...CREDIT_SOURCES.map((s) => ({
                  value: s,
                  label: humanizeEnum(s),
                })),
              ],
            },
            {
              key: "status",
              label: "Filter by status",
              value: statusFilter,
              onChange: setStatusFilter,
              options: [
                { value: "ALL", label: "All statuses" },
                { value: "PENDING", label: "Pending" },
                { value: "ACTIVE", label: "Vested (Active)" },
                { value: "EXHAUSTED", label: "Exhausted" },
                { value: "EXPIRED", label: "Expired" },
                { value: "REVERSED", label: "Void / Reversed" },
              ],
            },
          ],
          setPage,
          allValue: "ALL",
        })}
        isLoading={creditsQuery.isLoading}
        error={
          creditsQuery.isError && !creditsQuery.data ? creditsQuery.error : null
        }
        onRetry={() => void creditsQuery.refetch()}
        loadingLabel="Loading credits…"
        emptyIcon={Gift}
        emptyMessage="No referral credits match the filter."
        columns={REFERRAL_CREDIT_COLUMNS}
        rows={rows}
        rowActions={renderRowActions}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
      />

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

// ---------------------------------------------------------------------------
// Tab 2: Fee Waivers Panel
// ---------------------------------------------------------------------------

function FeeWaiversTabPanel({
  canManage,
  grantOpen,
  onGrantOpenChange,
}: Readonly<{
  canManage: boolean;
  grantOpen: boolean;
  onGrantOpenChange: (open: boolean) => void;
}>) {
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [reasonFilter, setReasonFilter] = useState("ALL");
  const [page, setPage] = useState(1);

  const [revokeTarget, setRevokeTarget] = useState<FeeWaiverItem | null>(null);

  const waiversQuery = useQuery({
    queryKey: [
      "admin-fee-waivers",
      { q, status: statusFilter, reason: reasonFilter, page },
    ],
    queryFn: () =>
      fetchFeeWaivers({
        q,
        status: statusFilter,
        reason: reasonFilter,
        page,
      }),
  });

  const rows = waiversQuery.data?.data ?? [];
  const total = waiversQuery.data?.total ?? 0;
  const totalPages = waiversQuery.data?.totalPages ?? 1;
  const waiverSuffix = total === 1 ? "" : "s";
  const waiverCountLabel = countLabel(
    { loading: waiversQuery.isLoading, failed: waiversQuery.isError },
    total,
    () => `${total} fee waiver${waiverSuffix}`,
    "Fee waivers couldn't be loaded",
  );

  const renderRowActions = (w: FeeWaiverItem) => {
    const canRevoke = canManage && w.sessionsRemaining > 0;
    if (!canRevoke) return null;
    return (
      <div className="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="outline"
          className="text-red-600 hover:text-red-700"
          onClick={() => setRevokeTarget(w)}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> Revoke
        </Button>
      </div>
    );
  };

  return (
    <>
      <ReferralsListCard<FeeWaiverItem>
        title={waiverCountLabel}
        description="0% platform-fee session waivers granted to referred and referring experts."
        filters={pagedListFilters({
          search: {
            label: "Search fee waivers",
            placeholder: "Search by consultant name, email, or referral ID…",
            value: q,
            onChange: setQ,
          },
          selects: [
            {
              key: "reason",
              label: "Filter by waiver reason",
              value: reasonFilter,
              onChange: setReasonFilter,
              options: [
                { value: "ALL", label: "All reasons" },
                { value: "REFERRED_EXPERT", label: "Referred Expert" },
                { value: "REFERRING_EXPERT", label: "Referring Expert" },
                { value: "FOUNDING_EXPERT", label: "Founding Expert" },
              ],
            },
            {
              key: "status",
              label: "Filter by waiver status",
              value: statusFilter,
              onChange: setStatusFilter,
              options: [
                { value: "ALL", label: "All statuses" },
                { value: "ACTIVE", label: "Active" },
                { value: "EXHAUSTED", label: "Exhausted" },
                { value: "EXPIRED", label: "Expired" },
              ],
            },
          ],
          setPage,
          allValue: "ALL",
        })}
        isLoading={waiversQuery.isLoading}
        error={
          waiversQuery.isError && !waiversQuery.data ? waiversQuery.error : null
        }
        onRetry={() => void waiversQuery.refetch()}
        loadingLabel="Loading fee waivers…"
        emptyIcon={Sparkles}
        emptyMessage="No consultant fee waivers found."
        columns={FEE_WAIVER_COLUMNS}
        rows={rows}
        rowActions={canManage ? renderRowActions : undefined}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
      />

      {canManage && (
        <GrantFeeWaiverDialog
          open={grantOpen}
          onOpenChange={onGrantOpenChange}
        />
      )}

      {revokeTarget && canManage && (
        <RevokeFeeWaiverDialog
          waiver={revokeTarget}
          open={!!revokeTarget}
          onOpenChange={(v) => !v && setRevokeTarget(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 4: Referral program economics
// ---------------------------------------------------------------------------

function ProgramEconomicsTabPanel({
  canManage,
}: Readonly<{ canManage: boolean }>) {
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ["admin-referral-program-config"],
    queryFn: async () => {
      const res = await fetch("/api/admin/referrals/config");
      if (!res.ok) throw new Error("Failed to load referral program config");
      const json = (await res.json()) as { config: ReferralProgramConfigData };
      return json.config;
    },
  });

  const cfg = configQuery.data;

  const [paused, setPaused] = useState(false);
  const [monthlyBudgetINR, setMonthlyBudgetINR] = useState("");
  const [referrerRewardINR, setReferrerRewardINR] = useState("");
  const [discountBps, setDiscountBps] = useState("");
  const [discountMaxINR, setDiscountMaxINR] = useState("");
  const [redemptionCapBps, setRedemptionCapBps] = useState("");
  const [minOrderINR, setMinOrderINR] = useState("");
  const [configReason, setConfigReason] = useState("");
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    if (!cfg) return;
    setPaused(cfg.paused);
    setMonthlyBudgetINR(String(cfg.monthlyBudgetPaise / 100));
    setReferrerRewardINR(String(cfg.referrerRewardPaise / 100));
    setDiscountBps(String(cfg.discountBps));
    setDiscountMaxINR(String(cfg.discountMaxPaise / 100));
    setRedemptionCapBps(String(cfg.redemptionCapBps));
    setMinOrderINR(String(cfg.minOrderPaise / 100));
  }, [cfg]);

  const updateConfigMutation = useMutation({
    mutationFn: async (payload: {
      expectedVersion: number;
      paused: boolean;
      monthlyBudgetPaise: number;
      referrerRewardPaise: number;
      discountBps: number;
      discountMaxPaise: number;
      redemptionCapBps: number;
      minOrderPaise: number;
      reason: string;
    }) => {
      const res = await fetch("/api/admin/referrals/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            "Failed to update referral config",
        );
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin-referral-program-config"],
      });
      setConfigReason("");
      setConfigError(null);
      setConfigMessage("Referral program configuration updated.");
    },
    onError: (err: Error) => {
      setConfigMessage(null);
      setConfigError(err.message);
    },
  });

  const handleSaveConfig = () => {
    setConfigError(null);
    setConfigMessage(null);
    if (!cfg) return;

    const monthlyBudgetPaise = parseNonNegativeInrToPaise(monthlyBudgetINR);
    const referrerRewardPaise = parseNonNegativeInrToPaise(referrerRewardINR);
    const discountMaxPaise = parseNonNegativeInrToPaise(discountMaxINR);
    const minOrderPaise = parseNonNegativeInrToPaise(minOrderINR);
    const parsedDiscountBps = Number.parseInt(discountBps, 10);
    const parsedRedemptionCapBps = Number.parseInt(redemptionCapBps, 10);

    if (
      monthlyBudgetPaise === null ||
      referrerRewardPaise === null ||
      discountMaxPaise === null ||
      minOrderPaise === null
    ) {
      setConfigError("All INR amounts must be valid non-negative numbers.");
      return;
    }
    if (
      !Number.isInteger(parsedDiscountBps) ||
      parsedDiscountBps < 0 ||
      parsedDiscountBps > 10000 ||
      !Number.isInteger(parsedRedemptionCapBps) ||
      parsedRedemptionCapBps < 0 ||
      parsedRedemptionCapBps > 10000
    ) {
      setConfigError("Basis points must be integers between 0 and 10000.");
      return;
    }
    if (configReason.trim().length < 5) {
      setConfigError("Audit reason (at least 5 characters) is required.");
      return;
    }

    updateConfigMutation.mutate({
      expectedVersion: cfg.version,
      paused,
      monthlyBudgetPaise,
      referrerRewardPaise,
      discountBps: parsedDiscountBps,
      discountMaxPaise,
      redemptionCapBps: parsedRedemptionCapBps,
      minOrderPaise,
      reason: configReason.trim(),
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Settings2 className="h-4 w-4" /> Referral Program Economics
              </CardTitle>
              <CardDescription>
                Optimistic-locked singleton configuration (version{" "}
                {cfg?.version ?? "—"}). Spent this period (
                {cfg?.currentPeriod || "current"}):{" "}
                {formatCurrencyAmount(cfg?.currentMonthSpentPaise ?? 0, "INR")}.
              </CardDescription>
            </div>
            {cfg && (
              <StatusBadge
                label={cfg.paused ? "PAUSED" : "ACTIVE"}
                tone={cfg.paused ? "warning" : "success"}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {configQuery.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading program
              config…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-paused">Program status</Label>
                  <Select
                    disabled={!canManage}
                    value={paused ? "PAUSED" : "ACTIVE"}
                    onValueChange={(v) => setPaused(v === "PAUSED")}
                  >
                    <SelectTrigger id="cfg-paused">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="PAUSED">Paused</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {[
                  {
                    id: "cfg-budget",
                    label: "Monthly Budget (₹)",
                    value: monthlyBudgetINR,
                    onChange: setMonthlyBudgetINR,
                  },
                  {
                    id: "cfg-reward",
                    label: "Referrer Reward (₹)",
                    value: referrerRewardINR,
                    onChange: setReferrerRewardINR,
                  },
                  {
                    id: "cfg-discount-bps",
                    label: "Referee Discount (bps)",
                    value: discountBps,
                    onChange: setDiscountBps,
                  },
                  {
                    id: "cfg-discount-max",
                    label: "Max Referee Discount (₹)",
                    value: discountMaxINR,
                    onChange: setDiscountMaxINR,
                  },
                  {
                    id: "cfg-redemption-bps",
                    label: "Redemption Cap (bps)",
                    value: redemptionCapBps,
                    onChange: setRedemptionCapBps,
                  },
                  {
                    id: "cfg-min-order",
                    label: "Min Order Amount (₹)",
                    value: minOrderINR,
                    onChange: setMinOrderINR,
                  },
                ].map((field) => (
                  <div key={field.id} className="space-y-1.5">
                    <Label htmlFor={field.id}>{field.label}</Label>
                    <Input
                      id={field.id}
                      type="number"
                      disabled={!canManage}
                      value={field.value}
                      onChange={(e) => field.onChange(e.target.value)}
                    />
                  </div>
                ))}

                {canManage && (
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="cfg-reason">Audit reason *</Label>
                    <Input
                      id="cfg-reason"
                      value={configReason}
                      onChange={(e) => setConfigReason(e.target.value)}
                      placeholder="Reason for updating referral program economics"
                    />
                  </div>
                )}
              </div>

              {configError && (
                <p className="text-sm text-red-600">{configError}</p>
              )}
              {configMessage && (
                <p className="text-sm text-emerald-600">{configMessage}</p>
              )}

              {canManage && (
                <div className="flex justify-end">
                  <Button
                    onClick={handleSaveConfig}
                    disabled={updateConfigMutation.isPending}
                  >
                    {updateConfigMutation.isPending ? (
                      <>
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />{" "}
                        Saving…
                      </>
                    ) : (
                      "Save Program Config"
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page Client
// ---------------------------------------------------------------------------

export function ReferralCreditsPageClient() {
  const { can } = useBackofficeCapability();
  const canManage = can("referrals.manage");
  const searchParams = useSearchParams();
  const rawTab = searchParams?.get("tab");
  const [activeTab, setActiveTab] = useState(
    rawTab === "waivers" || rawTab === "config" || rawTab === "held"
      ? rawTab
      : "credits",
  );
  const [issueOpen, setIssueOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);

  let headerAction: React.ReactNode = null;
  if (canManage && activeTab === "credits") {
    headerAction = (
      <Button size="sm" onClick={() => setIssueOpen(true)}>
        <Plus className="mr-1 h-4 w-4" /> Issue Goodwill Credit
      </Button>
    );
  } else if (canManage && activeTab === "waivers") {
    headerAction = (
      <Button size="sm" onClick={() => setGrantOpen(true)}>
        <Plus className="mr-1 h-4 w-4" /> Grant Fee Waiver
      </Button>
    );
  }

  return (
    <>
      <DashboardHeader
        title="Referral credits"
        subtitle="Referral credit balances, expert fee waivers, referrals held for review and the program economics. The platform take rates are on Platform fees."
        actions={headerAction}
      />

      <DashboardContent>
        <UrlTabs
          onTabChange={setActiveTab}
          tabs={[
            {
              value: "credits",
              label: "Credits",
              content: <CreditsTabPanel canManage={canManage} />,
            },
            {
              value: "waivers",
              label: "Fee Waivers",
              content: (
                <FeeWaiversTabPanel
                  canManage={canManage}
                  grantOpen={grantOpen}
                  onGrantOpenChange={setGrantOpen}
                />
              ),
            },
            {
              value: "held",
              label: "Held for review",
              show: canManage,
              content: <HeldReferralsPanel />,
            },
            {
              value: "config",
              label: "Program economics",
              content: <ProgramEconomicsTabPanel canManage={canManage} />,
            },
          ]}
        />
      </DashboardContent>

      {canManage && (
        <IssueGoodwillCreditDialog
          open={issueOpen}
          onOpenChange={setIssueOpen}
        />
      )}
    </>
  );
}

export default ReferralCreditsPageClient;
