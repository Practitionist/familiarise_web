"use client";

import { use, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  FileText,
  Loader2,
  Check,
  X,
  Eye,
  Pencil,
  Lock,
  RefreshCw,
} from "lucide-react";
import type { ContractStatus, FundingSource } from "@prisma/client";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { FUNDING_SOURCE_LABEL } from "@/lib/labels/org-labels";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
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
  supersededByContractId?: string | null;
  supersededAt?: string | null;
  supersessionReason?: string | null;
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
  subscription: {
    id: string;
    model: "PER_SEAT" | "FLAT_FEE";
    cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
    flatFeePaise: number | null;
    ratePerSeatPaise: number | null;
    activeSeatCount: number;
  } | null;
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

async function fetchContracts(
  orgId: string,
): Promise<{ data: ContractItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/contracts`);
  if (!res.ok) throw new Error("Failed to load contracts");
  return res.json();
}

async function fetchBillingAccount(
  orgId: string,
): Promise<{ billingAccount: BillingAccount }> {
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
    paymentTermsDays?: number;
    autoRenew: boolean;
    status: "DRAFT" | "ACTIVE";
    licenseModel?: "FLAT_FEE" | "PER_SEAT";
    licenseFeePaise?: number;
    licenseRatePerSeatPaise?: number;
    licenseCycle?: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  },
) {
  const res = await fetch(`/api/organizations/${orgId}/contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to create contract",
    );
  }
  return json;
}

async function supersedeContract(
  orgId: string,
  contractId: string,
  body: {
    reason: "AMENDMENT" | "RENEWAL";
    effectiveFrom: string;
    effectiveTo?: string | null;
    paymentTermsDays?: number;
    autoRenew?: boolean;
    licenseModel?: "FLAT_FEE" | "PER_SEAT";
    licenseFeePaise?: number;
    licenseRatePerSeatPaise?: number;
    licenseCycle?: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  },
) {
  const res = await fetch(
    `/api/organizations/${orgId}/contracts/${contractId}/supersede`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to supersede contract",
    );
  }
  return json;
}

async function patchContract(
  orgId: string,
  contractId: string,
  body: { status?: ContractStatus; signedAt?: string | null },
) {
  const res = await fetch(
    `/api/organizations/${orgId}/contracts/${contractId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to update contract",
    );
  }
  return json;
}

async function deleteContract(orgId: string, contractId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/contracts/${contractId}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(
      (json as { error?: string }).error ?? "Failed to delete contract",
    );
  }
}

// Single-contract GET carries the server-derived `locked` flag so the
// detail/edit drawer can disable term fields without re-deriving the rule
// client-side (#777 §B).
type ContractDetail = ContractItem & { locked: boolean };

async function fetchContract(
  orgId: string,
  contractId: string,
): Promise<{ contract: ContractDetail }> {
  const res = await fetch(
    `/api/organizations/${orgId}/contracts/${contractId}`,
  );
  if (!res.ok) throw new Error("Failed to load contract");
  return res.json();
}

// Edit PATCH — autoRenew always allowed; the term fields only go through
// when the contract isn't locked. The server re-checks and 409s
// CONTRACT_TERMS_LOCKED if a locked term field slips past.
async function editContract(
  orgId: string,
  contractId: string,
  body: {
    autoRenew?: boolean;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    paymentTermsDays?: number;
  },
) {
  const res = await fetch(
    `/api/organizations/${orgId}/contracts/${contractId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to update contract",
    );
  }
  return json;
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

// #1762-4 — labels + tones instead of the raw enum.
const CONTRACT_STATUS: Record<ContractStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  ACTIVE: { label: "Active", tone: "success" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  TERMINATED: { label: "Terminated", tone: "neutral" },
};

const CYCLE_NOUN: Record<string, string> = {
  MONTHLY: "month",
  QUARTERLY: "quarter",
  ANNUAL: "year",
};

function fundingLabel(source: string | undefined): string {
  if (!source) return "—";
  return FUNDING_SOURCE_LABEL[source as FundingSource] ?? humanizeEnum(source);
}

function fmtSubscription(sub: {
  model: string;
  cycle: string;
  flatFeePaise: number | null;
  ratePerSeatPaise?: number | null;
  activeSeatCount?: number;
}): string {
  const per = CYCLE_NOUN[sub.cycle] ?? humanizeEnum(sub.cycle).toLowerCase();
  if (sub.model === "FLAT_FEE" && sub.flatFeePaise !== null) {
    return `${formatCurrencyAmount(sub.flatFeePaise, "INR")} per ${per}`;
  }
  if (
    sub.model === "PER_SEAT" &&
    sub.ratePerSeatPaise !== null &&
    sub.ratePerSeatPaise !== undefined
  ) {
    const seats = sub.activeSeatCount ?? 0;
    return `${formatCurrencyAmount(sub.ratePerSeatPaise, "INR")} / seat / ${per} (${seats} active)`;
  }
  return `${humanizeEnum(sub.model)}, billed per ${per}`;
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

type ContractFinancialDraft = {
  effectiveFrom: string;
  effectiveTo: string;
  isLicense: boolean;
  paymentTermsDays: string;
  autoRenew: boolean;
  licenseModel: "FLAT_FEE" | "PER_SEAT";
  licenseCycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  licenseFeeINR: string;
  ratePerSeatINR: string;
};

type ContractFinancialPayload = {
  effectiveFrom: string;
  effectiveTo: string | null;
  paymentTermsDays?: number;
  autoRenew: boolean;
  licenseModel?: "FLAT_FEE" | "PER_SEAT";
  licenseFeePaise?: number;
  licenseRatePerSeatPaise?: number;
  licenseCycle?: "MONTHLY" | "QUARTERLY" | "ANNUAL";
};

function parseContractTermWindow(
  draft: Pick<ContractFinancialDraft, "effectiveFrom" | "effectiveTo">,
): { fromDate: Date; toDate: Date | null } | { error: string } {
  const fromDate = new Date(draft.effectiveFrom);
  if (!draft.effectiveFrom || Number.isNaN(fromDate.getTime())) {
    return { error: "Start date is required." };
  }
  const toDate = draft.effectiveTo ? new Date(draft.effectiveTo) : null;
  if (toDate && Number.isNaN(toDate.getTime())) {
    return { error: "End date is invalid." };
  }
  if (toDate && toDate <= fromDate) {
    return { error: "End date must be after the start date." };
  }
  return { fromDate, toDate };
}

function parsePositiveInrToPaise(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [wholePart, fracPart = ""] = trimmed.split(".");
  const paise =
    Number.parseInt(wholePart, 10) * 100 +
    Number.parseInt(fracPart.padEnd(2, "0"), 10);
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

function parseLicensePricingOverride(
  draft: Pick<
    ContractFinancialDraft,
    "isLicense" | "licenseModel" | "licenseFeeINR" | "ratePerSeatINR"
  >,
):
  | { licenseFeePaise?: number; licenseRatePerSeatPaise?: number }
  | { error: string } {
  if (!draft.isLicense) {
    return {};
  }
  if (draft.licenseModel === "FLAT_FEE" && draft.licenseFeeINR.trim() !== "") {
    const licenseFeePaise = parsePositiveInrToPaise(draft.licenseFeeINR);
    if (licenseFeePaise === null) {
      return { error: "License fee must be a positive number (₹)." };
    }
    return { licenseFeePaise };
  }
  if (
    draft.licenseModel === "PER_SEAT" &&
    draft.ratePerSeatINR.trim() !== ""
  ) {
    const licenseRatePerSeatPaise = parsePositiveInrToPaise(
      draft.ratePerSeatINR,
    );
    if (licenseRatePerSeatPaise === null) {
      return { error: "Rate per seat must be a positive number (₹)." };
    }
    return { licenseRatePerSeatPaise };
  }
  return {};
}

function buildContractFinancialPayload(
  draft: ContractFinancialDraft,
): { payload: ContractFinancialPayload } | { error: string } {
  const windowResult = parseContractTermWindow(draft);
  if ("error" in windowResult) {
    return windowResult;
  }
  const { fromDate, toDate } = windowResult;

  let terms: number | undefined;
  if (!draft.isLicense) {
    const parsed = Number.parseInt(draft.paymentTermsDays, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
      return { error: "Payment terms must be between 1 and 120 days." };
    }
    terms = parsed;
  }

  const licenseResult = parseLicensePricingOverride(draft);
  if ("error" in licenseResult) {
    return licenseResult;
  }
  const { licenseFeePaise, licenseRatePerSeatPaise } = licenseResult;

  return {
    payload: {
      effectiveFrom: fromDate.toISOString(),
      effectiveTo: toDate ? toDate.toISOString() : null,
      ...(terms !== undefined ? { paymentTermsDays: terms } : {}),
      autoRenew: draft.autoRenew,
      ...(licenseFeePaise !== undefined
        ? {
            licenseModel: "FLAT_FEE",
            licenseFeePaise,
            licenseCycle: draft.licenseCycle,
          }
        : {}),
      ...(licenseRatePerSeatPaise !== undefined
        ? {
            licenseModel: "PER_SEAT",
            licenseRatePerSeatPaise,
            licenseCycle: draft.licenseCycle,
          }
        : {}),
    },
  };
}

function ContractFinancialTermsFields({
  idPrefix,
  effectiveFrom,
  onEffectiveFromChange,
  effectiveTo,
  onEffectiveToChange,
  isLicense,
  paymentTermsDays,
  onPaymentTermsDaysChange,
  licenseModel,
  onLicenseModelChange,
  licenseCycle,
  onLicenseCycleChange,
  licenseFeeINR,
  onLicenseFeeINRChange,
  ratePerSeatINR,
  onRatePerSeatINRChange,
  autoRenew,
  onAutoRenewChange,
  children,
}: Readonly<{
  idPrefix: string;
  effectiveFrom: string;
  onEffectiveFromChange: (v: string) => void;
  effectiveTo: string;
  onEffectiveToChange: (v: string) => void;
  isLicense: boolean;
  paymentTermsDays: string;
  onPaymentTermsDaysChange: (v: string) => void;
  licenseModel: "FLAT_FEE" | "PER_SEAT";
  onLicenseModelChange: (v: "FLAT_FEE" | "PER_SEAT") => void;
  licenseCycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  onLicenseCycleChange: (v: "MONTHLY" | "QUARTERLY" | "ANNUAL") => void;
  licenseFeeINR: string;
  onLicenseFeeINRChange: (v: string) => void;
  ratePerSeatINR: string;
  onRatePerSeatINRChange: (v: string) => void;
  autoRenew: boolean;
  onAutoRenewChange: (v: boolean) => void;
  children?: ReactNode;
}>) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-effective-from`}>Effective from *</Label>
          <Input
            id={`${idPrefix}-effective-from`}
            type="date"
            value={effectiveFrom}
            onChange={(e) => onEffectiveFromChange(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-effective-to`}>Effective to</Label>
          <Input
            id={`${idPrefix}-effective-to`}
            type="date"
            value={effectiveTo}
            onChange={(e) => onEffectiveToChange(e.target.value)}
            placeholder="Open-ended"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank for open-ended
          </p>
        </div>
      </div>

      {!isLicense && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-payment-terms`}>
            Payment terms (days) *
          </Label>
          <Input
            id={`${idPrefix}-payment-terms`}
            type="number"
            min={1}
            max={120}
            value={paymentTermsDays}
            onChange={(e) => onPaymentTermsDaysChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            NET-{paymentTermsDays || "?"} — how many days after invoice date the
            org must pay.
          </p>
        </div>
      )}

      {isLicense && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>License model</Label>
            <div className="flex gap-2">
              {(
                [
                  { value: "FLAT_FEE", label: "Flat fee" },
                  { value: "PER_SEAT", label: "Per seat" },
                ] as const
              ).map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => onLicenseModelChange(m.value)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    licenseModel === m.value
                      ? "border-foreground bg-foreground text-background"
                      : "border-border hover:border-foreground/40"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {licenseModel === "FLAT_FEE" ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-license-fee`}>
                  Flat license fee (₹/{CYCLE_NOUN[licenseCycle] ?? "cycle"})
                </Label>
                <Input
                  id={`${idPrefix}-license-fee`}
                  type="number"
                  min={1}
                  step="1"
                  placeholder="e.g. 750000"
                  value={licenseFeeINR}
                  onChange={(e) => onLicenseFeeINRChange(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Optional. Enables renewal billing and dashboard display.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-rate-per-seat`}>
                  Rate per seat (₹/{CYCLE_NOUN[licenseCycle] ?? "cycle"})
                </Label>
                <Input
                  id={`${idPrefix}-rate-per-seat`}
                  type="number"
                  min={1}
                  step="1"
                  placeholder="e.g. 1500"
                  value={ratePerSeatINR}
                  onChange={(e) => onRatePerSeatINRChange(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Billed per active learner seat each cycle.
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-license-cycle`}>Billing cycle</Label>
              <select
                id={`${idPrefix}-license-cycle`}
                className="flex h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                value={licenseCycle}
                onChange={(e) =>
                  onLicenseCycleChange(
                    e.target.value as "MONTHLY" | "QUARTERLY" | "ANNUAL",
                  )
                }
              >
                <option value="ANNUAL">Annual</option>
                <option value="QUARTERLY">Quarterly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {children}

      <label className="flex items-center gap-2 cursor-pointer">
        <Checkbox
          checked={autoRenew}
          onCheckedChange={(v) => onAutoRenewChange(v === true)}
        />
        <span className="text-sm">Auto-renew when effective-to date passes</span>
      </label>
    </>
  );
}

function CreateContractDialog({
  orgId,
  billingAccountId,
  fundingSource,
  open,
  onOpenChange,
}: Readonly<{
  orgId: string;
  billingAccountId: string;
  fundingSource?: FundingSource | string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const queryClient = useQueryClient();

  const today = new Date().toISOString().slice(0, 10);
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [effectiveTo, setEffectiveTo] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("60");
  const [autoRenew, setAutoRenew] = useState(false);
  const [status, setStatus] = useState<"DRAFT" | "ACTIVE">("ACTIVE");
  const [licenseModel, setLicenseModel] = useState<"FLAT_FEE" | "PER_SEAT">(
    "FLAT_FEE",
  );
  const [licenseFeeINR, setLicenseFeeINR] = useState("");
  const [ratePerSeatINR, setRatePerSeatINR] = useState("");
  const [licenseCycle, setLicenseCycle] = useState<
    "MONTHLY" | "QUARTERLY" | "ANNUAL"
  >("ANNUAL");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEffectiveFrom(today);
    setEffectiveTo("");
    setPaymentTermsDays("60");
    setAutoRenew(false);
    setStatus("ACTIVE");
    setLicenseModel("FLAT_FEE");
    setLicenseFeeINR("");
    setRatePerSeatINR("");
    setLicenseCycle("ANNUAL");
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: (body: Parameters<typeof createContract>[1]) =>
      createContract(orgId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      // Also invalidate the active-contracts cache used by Programs page.
      queryClient.invalidateQueries({
        queryKey: ["org-contracts-active", orgId],
      });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    const built = buildContractFinancialPayload({
      effectiveFrom,
      effectiveTo,
      isLicense: fundingSource === "LICENSE",
      paymentTermsDays,
      autoRenew,
      licenseModel,
      licenseCycle,
      licenseFeeINR,
      ratePerSeatINR,
    });
    if ("error" in built) {
      setError(built.error);
      return;
    }
    createMutation.mutate({
      billingAccountId,
      status,
      ...built.payload,
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
      <ResponsiveModalContent className="sm:max-w-md max-h-[90vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>New Contract</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <ContractFinancialTermsFields
            idPrefix="create"
            effectiveFrom={effectiveFrom}
            onEffectiveFromChange={setEffectiveFrom}
            effectiveTo={effectiveTo}
            onEffectiveToChange={setEffectiveTo}
            isLicense={fundingSource === "LICENSE"}
            paymentTermsDays={paymentTermsDays}
            onPaymentTermsDaysChange={setPaymentTermsDays}
            licenseModel={licenseModel}
            onLicenseModelChange={setLicenseModel}
            licenseCycle={licenseCycle}
            onLicenseCycleChange={setLicenseCycle}
            licenseFeeINR={licenseFeeINR}
            onLicenseFeeINRChange={setLicenseFeeINR}
            ratePerSeatINR={ratePerSeatINR}
            onRatePerSeatINRChange={setRatePerSeatINR}
            autoRenew={autoRenew}
            onAutoRenewChange={setAutoRenew}
          >
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
                        ? "border-foreground bg-foreground text-background"
                        : "border-border hover:border-foreground/40"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                ACTIVE contracts can immediately attach Programs. DRAFT
                contracts need to be activated first.
              </p>
            </div>
          </ContractFinancialTermsFields>

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
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Creating…
              </>
            ) : (
              "Create"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Supersede (Amend / Renew) dialog (#770 / #1844)
// ---------------------------------------------------------------------------

function SupersedeContractDialog({
  orgId,
  contract,
  open,
  onOpenChange,
}: Readonly<{
  orgId: string;
  contract: ContractItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const isLicense = contract.billingAccount?.fundingSource === "LICENSE";
  const today = new Date().toISOString().slice(0, 10);

  const [reason, setReason] = useState<"AMENDMENT" | "RENEWAL">("AMENDMENT");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [effectiveTo, setEffectiveTo] = useState(
    contract.effectiveTo ? contract.effectiveTo.slice(0, 10) : "",
  );
  const [paymentTermsDays, setPaymentTermsDays] = useState(
    String(contract.paymentTermsDays),
  );
  const [autoRenew, setAutoRenew] = useState(contract.autoRenew);
  const [licenseModel, setLicenseModel] = useState<"FLAT_FEE" | "PER_SEAT">(
    contract.subscription?.model ?? "FLAT_FEE",
  );
  const [licenseCycle, setLicenseCycle] = useState<
    "MONTHLY" | "QUARTERLY" | "ANNUAL"
  >(contract.subscription?.cycle ?? "ANNUAL");
  const [licenseFeeINR, setLicenseFeeINR] = useState(
    contract.subscription?.flatFeePaise !== null &&
      contract.subscription?.flatFeePaise !== undefined
      ? String(contract.subscription.flatFeePaise / 100)
      : "",
  );
  const [ratePerSeatINR, setRatePerSeatINR] = useState(
    contract.subscription?.ratePerSeatPaise !== null &&
      contract.subscription?.ratePerSeatPaise !== undefined
      ? String(contract.subscription.ratePerSeatPaise / 100)
      : "",
  );
  const [error, setError] = useState<string | null>(null);

  const contractRef = useRef(contract);
  useEffect(() => {
    contractRef.current = contract;
  }, [contract]);

  useEffect(() => {
    if (!open) return;
    const current = contractRef.current;
    setReason("AMENDMENT");
    setEffectiveFrom(new Date().toISOString().slice(0, 10));
    setEffectiveTo(
      current.effectiveTo ? current.effectiveTo.slice(0, 10) : "",
    );
    setPaymentTermsDays(String(current.paymentTermsDays));
    setAutoRenew(current.autoRenew);
    setLicenseModel(current.subscription?.model ?? "FLAT_FEE");
    setLicenseCycle(current.subscription?.cycle ?? "ANNUAL");
    setLicenseFeeINR(
      current.subscription?.flatFeePaise !== null &&
        current.subscription?.flatFeePaise !== undefined
        ? String(current.subscription.flatFeePaise / 100)
        : "",
    );
    setRatePerSeatINR(
      current.subscription?.ratePerSeatPaise !== null &&
        current.subscription?.ratePerSeatPaise !== undefined
        ? String(current.subscription.ratePerSeatPaise / 100)
        : "",
    );
    setError(null);
  }, [open, contract.id]);

  const supersedeMutation = useMutation({
    mutationFn: (body: Parameters<typeof supersedeContract>[2]) =>
      supersedeContract(orgId, contract.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      queryClient.invalidateQueries({
        queryKey: ["org-contracts-active", orgId],
      });
      queryClient.invalidateQueries({
        queryKey: ["org-contract", orgId, contract.id],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (isLicense) {
      const origModel = contract.subscription?.model ?? "FLAT_FEE";
      const origCycle = contract.subscription?.cycle ?? "ANNUAL";
      const modelOrCycleChanged =
        licenseModel !== origModel || licenseCycle !== origCycle;
      const activeFeeBlank =
        licenseModel === "FLAT_FEE"
          ? licenseFeeINR.trim() === ""
          : ratePerSeatINR.trim() === "";
      if (modelOrCycleChanged && activeFeeBlank) {
        setError(
          "Enter the license fee or rate per seat when changing the license model or billing cycle.",
        );
        return;
      }
    }
    const built = buildContractFinancialPayload({
      effectiveFrom,
      effectiveTo,
      isLicense,
      paymentTermsDays,
      autoRenew,
      licenseModel,
      licenseCycle,
      licenseFeeINR,
      ratePerSeatINR,
    });
    if ("error" in built) {
      setError(built.error);
      return;
    }

    supersedeMutation.mutate({
      reason,
      ...built.payload,
    });
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md max-h-[90vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Amend / Renew Contract</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
            Creates a new ACTIVE contract with updated terms, transfers all
            attached programs and license subscriptions, and retires the current
            contract with a supersession audit trail.
          </p>

          <div className="space-y-1.5">
            <Label>Supersession type *</Label>
            <div className="flex gap-2">
              {(
                [
                  { value: "AMENDMENT", label: "Mid-term amendment" },
                  { value: "RENEWAL", label: "Term renewal" },
                ] as const
              ).map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => {
                    setReason(r.value);
                    if (r.value === "RENEWAL" && contract.effectiveTo) {
                      const nextStartIso = contract.effectiveTo.slice(0, 10);
                      setEffectiveFrom(nextStartIso);
                      const oldFromMs = new Date(
                        contract.effectiveFrom,
                      ).getTime();
                      const oldToMs = new Date(contract.effectiveTo).getTime();
                      const durationMs = Math.max(
                        86_400_000,
                        Number.isFinite(oldToMs - oldFromMs)
                          ? oldToMs - oldFromMs
                          : 365 * 86_400_000,
                      );
                      const nextEnd = new Date(
                        new Date(nextStartIso).getTime() + durationMs,
                      );
                      setEffectiveTo(nextEnd.toISOString().slice(0, 10));
                    } else {
                      setEffectiveFrom(today);
                      setEffectiveTo(
                        contract.effectiveTo
                          ? contract.effectiveTo.slice(0, 10)
                          : "",
                      );
                    }
                  }}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    reason === r.value
                      ? "border-foreground bg-foreground text-background"
                      : "border-border hover:border-foreground/40"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <ContractFinancialTermsFields
            idPrefix="supersede"
            effectiveFrom={effectiveFrom}
            onEffectiveFromChange={setEffectiveFrom}
            effectiveTo={effectiveTo}
            onEffectiveToChange={setEffectiveTo}
            isLicense={isLicense}
            paymentTermsDays={paymentTermsDays}
            onPaymentTermsDaysChange={setPaymentTermsDays}
            licenseModel={licenseModel}
            onLicenseModelChange={setLicenseModel}
            licenseCycle={licenseCycle}
            onLicenseCycleChange={setLicenseCycle}
            licenseFeeINR={licenseFeeINR}
            onLicenseFeeINRChange={setLicenseFeeINR}
            ratePerSeatINR={ratePerSeatINR}
            onRatePerSeatINRChange={setRatePerSeatINR}
            autoRenew={autoRenew}
            onAutoRenewChange={setAutoRenew}
          />

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={supersedeMutation.isPending}
          >
            {supersedeMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Superseding…
              </>
            ) : (
              "Supersede contract"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer (#777 §B) — read-only view of a single contract: status,
// effective window, payment terms (Prepaid for LICENSE), auto-renew, and the
// programs / subscription riding on it.
// ---------------------------------------------------------------------------

// LICENSE contracts pay the flat fee upfront, so net-X payment terms don't
// apply — render "Prepaid" rather than a misleading NET-0 or em-dash.
function fmtPaymentTerms(
  c: Pick<ContractItem, "paymentTermsDays" | "billingAccount">,
): string {
  if (c.billingAccount?.fundingSource === "LICENSE") return "Prepaid";
  return `NET-${c.paymentTermsDays}`;
}

function formatContractTermsCell(c: ContractItem): string {
  if (c.billingAccount?.fundingSource !== "LICENSE") {
    return `NET-${c.paymentTermsDays}`;
  }
  if (
    c.subscription &&
    (c.subscription.flatFeePaise !== null ||
      c.subscription.ratePerSeatPaise !== null)
  ) {
    return fmtSubscription(c.subscription);
  }
  return "—";
}

function DetailRow({
  label,
  children,
}: Readonly<{
  label: string;
  children: ReactNode;
}>) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

function ContractDetailDialog({
  orgId,
  contractId,
  open,
  onOpenChange,
}: Readonly<{
  orgId: string;
  contractId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const detail = useQuery({
    queryKey: ["org-contract", orgId, contractId],
    queryFn: () => fetchContract(orgId, contractId),
    enabled: open,
  });
  const c = detail.data?.contract;

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md max-h-[85vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Contract detail</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        {detail.isLoading || !c ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="divide-y rounded-md border px-3">
              <DetailRow label="Status">
                <StatusBadge {...CONTRACT_STATUS[c.status]} />
              </DetailRow>
              <DetailRow label="Funding">
                {fundingLabel(c.billingAccount?.fundingSource)}
              </DetailRow>
              <DetailRow label="Effective from">
                {fmtDate(c.effectiveFrom)}
              </DetailRow>
              <DetailRow label="Effective to">
                {c.effectiveTo ? fmtDate(c.effectiveTo) : "open-ended"}
              </DetailRow>
              <DetailRow label="Payment terms">{fmtPaymentTerms(c)}</DetailRow>
              <DetailRow label="Auto-renew">
                {c.autoRenew ? "Yes" : "No"}
              </DetailRow>
              {c.subscription && (
                <DetailRow label="Subscription">
                  {fmtSubscription(c.subscription)}
                </DetailRow>
              )}
              {c.supersededByContractId && (
                <DetailRow label="Superseded by">
                  <span className="font-mono text-xs">
                    {c.supersededByContractId}
                  </span>
                </DetailRow>
              )}
              {c.supersessionReason && (
                <DetailRow label="Supersession reason">
                  {c.supersessionReason}
                </DetailRow>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold">
                Programs ({c.programs.length})
              </h4>
              {c.programs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No programs attached to this contract.
                </p>
              ) : (
                <ul className="space-y-1">
                  {c.programs.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                    >
                      <span>{p.name}</span>
                      <Badge variant="secondary" className="text-xs">
                        {humanizeEnum(p.type)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

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
// Edit dialog (#777 §B) — autoRenew editable always; effective dates and
// payment terms only while the contract isn't locked (still DRAFT, unsigned,
// no invoices / live assignments). The lock is server-derived.
// ---------------------------------------------------------------------------

function ContractLockedHint() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-600">
      <Lock className="h-3 w-3" /> Locked — in use
    </span>
  );
}

function EditContractDialog({
  orgId,
  contractId,
  open,
  onOpenChange,
}: Readonly<{
  orgId: string;
  contractId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["org-contract", orgId, contractId],
    queryFn: () => fetchContract(orgId, contractId),
    enabled: open,
  });
  const c = detail.data?.contract;
  const locked = c?.locked ?? true; // fail-safe: lock until we know
  const isLicense = c?.billingAccount?.fundingSource === "LICENSE";

  const [autoRenew, setAutoRenew] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!c) return;
    setAutoRenew(c.autoRenew);
    setEffectiveFrom(c.effectiveFrom.slice(0, 10));
    setEffectiveTo(c.effectiveTo ? c.effectiveTo.slice(0, 10) : "");
    setPaymentTermsDays(String(c.paymentTermsDays));
    setError(null);
  }, [c]);

  const editMutation = useMutation({
    mutationFn: (body: Parameters<typeof editContract>[2]) =>
      editContract(orgId, contractId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-contracts", orgId] });
      queryClient.invalidateQueries({
        queryKey: ["org-contracts-active", orgId],
      });
      queryClient.invalidateQueries({
        queryKey: ["org-contract", orgId, contractId],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (!c) return;
    // autoRenew is the only always-safe field. Term fields ride along only
    // when unlocked — the server is the final authority either way.
    const body: Parameters<typeof editContract>[2] = { autoRenew };
    if (!locked) {
      // A cleared/garbled date input is an empty string — new Date("") is an
      // Invalid Date and .toISOString() on it throws. Validate before use.
      const fromDate = new Date(effectiveFrom);
      if (!effectiveFrom || Number.isNaN(fromDate.getTime())) {
        setError("Start date is required.");
        return;
      }
      const toDate = effectiveTo ? new Date(effectiveTo) : null;
      if (toDate && Number.isNaN(toDate.getTime())) {
        setError("End date is invalid.");
        return;
      }
      if (toDate && toDate <= fromDate) {
        setError("End date must be after the start date.");
        return;
      }
      body.effectiveFrom = fromDate.toISOString();
      body.effectiveTo = toDate ? toDate.toISOString() : null;
      // LICENSE terms are prepaid — don't send paymentTermsDays for them.
      if (!isLicense) {
        const parsed = Number.parseInt(paymentTermsDays, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
          setError("Payment terms must be between 1 and 120 days.");
          return;
        }
        body.paymentTermsDays = parsed;
      }
    }
    editMutation.mutate(body);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-md max-h-[85vh] overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Edit contract</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        {detail.isLoading || !c ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            {locked && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                This contract is in use (signed, invoiced, or with live
                assignments). Effective dates and payment terms are locked —
                only auto-renew can be changed.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-effective-from">
                  Effective from
                  {locked && <ContractLockedHint />}
                </Label>
                <Input
                  id="edit-effective-from"
                  type="date"
                  disabled={locked}
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-effective-to">
                  Effective to
                  {locked && <ContractLockedHint />}
                </Label>
                <Input
                  id="edit-effective-to"
                  type="date"
                  disabled={locked}
                  value={effectiveTo}
                  onChange={(e) => setEffectiveTo(e.target.value)}
                  placeholder="Open-ended"
                />
              </div>
            </div>

            {!isLicense && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-payment-terms">
                  Payment terms (days)
                  {locked && <ContractLockedHint />}
                </Label>
                <Input
                  id="edit-payment-terms"
                  type="number"
                  min={1}
                  max={120}
                  disabled={locked}
                  value={paymentTermsDays}
                  onChange={(e) => setPaymentTermsDays(e.target.value)}
                />
              </div>
            )}

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={autoRenew}
                onCheckedChange={(v) => setAutoRenew(v === true)}
              />
              <span className="text-sm">
                Auto-renew when effective-to date passes
              </span>
            </label>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={editMutation.isPending || detail.isLoading || !c}
          >
            {editMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OrgContractsPage({
  params,
}: Readonly<{
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = use(params);
  const { can } = useOrgRole(orgId);
  // contracts.read now includes BILLING_ADMIN (reconciliation, #1527);
  // every write is contracts.manage, the routes' own grant.
  const canManage = can("contracts.manage");
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "contracts.read",
    canSponsor: true,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<ContractItem | null>(null);
  const [editTarget, setEditTarget] = useState<ContractItem | null>(null);
  const [supersedeTarget, setSupersedeTarget] = useState<ContractItem | null>(
    null,
  );
  const [activateTarget, setActivateTarget] = useState<ContractItem | null>(
    null,
  );
  const [terminateTarget, setTerminateTarget] = useState<ContractItem | null>(
    null,
  );
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
    enabled: allowed && canManage,
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
      queryClient.invalidateQueries({
        queryKey: ["org-contracts-active", orgId],
      });
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
      queryClient.invalidateQueries({
        queryKey: ["org-contracts-active", orgId],
      });
      setDeleteTarget(null);
      setActionError(null);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  if (!allowed) return null;

  const contractList = contracts.data?.data ?? [];
  const billingAccountId = billingAccount.data?.billingAccount?.id ?? "";
  const canCreate = canManage && !!billingAccountId;

  const columns: ResponsiveColumn<ContractItem>[] = [
    {
      key: "status",
      header: "Status",
      primary: true,
      cell: (c) => <StatusBadge {...CONTRACT_STATUS[c.status]} />,
    },
    {
      key: "funding",
      header: "Funding",
      className: "text-sm text-muted-foreground",
      cell: (c) => fundingLabel(c.billingAccount?.fundingSource),
    },
    {
      key: "period",
      header: "Period",
      className: "text-sm text-muted-foreground whitespace-nowrap",
      cell: (c) => (
        <>
          {fmtDate(c.effectiveFrom)} →{" "}
          {c.effectiveTo ? fmtDate(c.effectiveTo) : "open-ended"}
        </>
      ),
    },
    {
      key: "terms",
      header: "Terms",
      className: "text-sm text-muted-foreground",
      cell: (c) => (
        <>
          {formatContractTermsCell(c)}
          {c.autoRenew && (
            <span className="ml-1 text-xs text-muted-foreground/70">
              (auto-renew)
            </span>
          )}
        </>
      ),
    },
    {
      key: "programs",
      header: "Programs",
      className: "text-sm",
      cell: (c) =>
        c._count.programs > 0 ? (
          <span className="text-foreground">{c._count.programs}</span>
        ) : (
          <span className="text-muted-foreground/70">—</span>
        ),
    },
  ];

  const renderRowActions = (c: ContractItem) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setDetailTarget(c)}
        title="View detail"
      >
        <Eye className="h-3.5 w-3.5 mr-1" /> View
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setActionError(null);
          setEditTarget(c);
        }}
      >
        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
      </Button>
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
              className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
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
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setActionError(null);
              setSupersedeTarget(c);
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Amend / Renew
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
            onClick={() => {
              setActionError(null);
              setTerminateTarget(c);
            }}
          >
            Terminate
          </Button>
        </>
      )}
    </div>
  );

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
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : contractList.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
                <p className="text-sm">No contracts yet.</p>
                {canCreate && (
                  <p className="text-xs mt-2">
                    Click <strong>New Contract</strong> to create one. Programs
                    and invoices attach to a contract.
                  </p>
                )}
              </div>
            ) : (
              <ResponsiveTable<ContractItem>
                columns={columns}
                rows={contractList}
                getRowId={(c) => c.id}
                rowActions={canManage ? renderRowActions : undefined}
              />
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
          fundingSource={billingAccount.data?.billingAccount.fundingSource}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}

      {/* Detail drawer */}
      {detailTarget && (
        <ContractDetailDialog
          orgId={orgId}
          contractId={detailTarget.id}
          open={!!detailTarget}
          onOpenChange={(v) => {
            if (!v) setDetailTarget(null);
          }}
        />
      )}

      {/* Edit dialog */}
      {editTarget && (
        <EditContractDialog
          orgId={orgId}
          contractId={editTarget.id}
          open={!!editTarget}
          onOpenChange={(v) => {
            if (!v) setEditTarget(null);
          }}
        />
      )}

      {/* Supersede (Amend / Renew) dialog */}
      {supersedeTarget && (
        <SupersedeContractDialog
          orgId={orgId}
          contract={supersedeTarget}
          open={!!supersedeTarget}
          onOpenChange={(v) => {
            if (!v) setSupersedeTarget(null);
          }}
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
              This will move the contract from DRAFT to ACTIVE. Programs can be
              attached immediately. This action writes an audit log entry.
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
