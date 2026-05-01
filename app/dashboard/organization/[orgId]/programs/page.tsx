"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Briefcase, Loader2 } from "lucide-react";
import type {
  BillingCycle,
  OverageBehavior,
  ProgramStatus,
  ProgramType,
} from "@prisma/client";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { EnterpriseWipBanner } from "@/components/enterprise/EnterpriseWipBanner";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrencyAmount } from "@/utils/formatting";

// ---------------------------------------------------------------------------
// Types — shaped to match GET /api/organizations/[orgId]/programs
// ---------------------------------------------------------------------------

interface ProgramListItem {
  id: string;
  contractId: string;
  type: ProgramType;
  name: string;
  status: ProgramStatus;
  coveredPlanTypes: string[];
  allowedCategories: string[];
  createdAt: string;
  licensedSeatConfig: {
    ratePerSeatPaise: number;
    cycle: BillingCycle;
    coveredEngagementsPerCycle: number | null;
    overageBehavior: OverageBehavior;
    activeSeatCount: number;
  } | null;
  creditPoolConfig: {
    cycle: BillingCycle;
    creditsPerCycle: number;
    minimumCreditsPerPeriod: number | null;
  } | null;
  _count: { assignments: number };
}

interface ContractListItem {
  id: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  paymentTermsDays: number;
  billingAccount: { currency: string; fundingSource: string } | null;
  purchaseOrder: { poNumber: string } | null;
}

/**
 * Contracts don't have a user-defined name. Build a concise label from
 * the fields that a founder actually recognises — funding source, PO
 * number if present, and the effective window. The UUID prefix is kept
 * as a last-resort disambiguator (two contracts in the same funding
 * source signed on the same day would otherwise look identical).
 */
function formatContractLabel(c: ContractListItem): string {
  const funding = c.billingAccount?.fundingSource ?? "UNKNOWN";
  const po = c.purchaseOrder?.poNumber;
  const from = new Date(c.effectiveFrom).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const to = c.effectiveTo
    ? new Date(c.effectiveTo).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "open-ended";
  const suffix = po ? `PO ${po}` : `ref ${c.id.slice(0, 6)}`;
  return `${funding} · ${from} → ${to} · ${suffix}`;
}

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------

async function fetchPrograms(
  orgId: string,
): Promise<{ data: ProgramListItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/programs`);
  if (!res.ok) throw new Error("Failed to load programs");
  return res.json();
}

async function fetchContracts(
  orgId: string,
): Promise<{ data: ContractListItem[] }> {
  const res = await fetch(
    `/api/organizations/${orgId}/contracts?status=ACTIVE`,
  );
  if (!res.ok) throw new Error("Failed to load contracts");
  return res.json();
}

type CreateProgramBody =
  | {
      type: "LICENSED_SEAT";
      contractId: string;
      name: string;
      licensedSeatConfig: {
        ratePerSeatPaise: number;
        cycle: BillingCycle;
        coveredEngagementsPerCycle: number | null;
        overageBehavior: OverageBehavior;
      };
    }
  | {
      type: "CREDIT_POOL";
      contractId: string;
      name: string;
      creditPoolConfig: {
        cycle: BillingCycle;
        creditsPerCycle: number;
      };
    };

async function createProgram(orgId: string, body: CreateProgramBody) {
  const res = await fetch(`/api/organizations/${orgId}/programs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to create program",
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// Create-program dialog
// ---------------------------------------------------------------------------

const PROGRAM_TYPE_META: Record<
  ProgramType,
  { label: string; description: string; available: boolean }
> = {
  LICENSED_SEAT: {
    label: "Licensed seat",
    description:
      "Per-seat licence. Each seat covers N engagements (calendar occurrences) per cycle, or unlimited.",
    available: true,
  },
  CREDIT_POOL: {
    label: "Credit pool",
    description:
      "Pool with a per-cycle credit cap (1 credit = ₹1). Each booking debits credits from the org wallet up to the cap.",
    available: true,
  },
  PROJECT: {
    label: "Project",
    description: "Fixed-fee engagement. Reserved for v2.",
    available: false,
  },
  RETAINER: {
    label: "Retainer",
    description: "Monthly retainer with rollover. Reserved for v2.",
    available: false,
  },
};

const BILLING_CYCLES: BillingCycle[] = ["MONTHLY", "QUARTERLY", "ANNUAL"];

// Money inputs take rupees (major units) for typing ergonomics. Paise
// conversion happens at submit time so the DB always stores paise
// (consistent with the rest of the enterprise schema).
function rupeesToPaise(rupees: string): number | null {
  const trimmed = rupees.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function CreateProgramDialog({
  orgId,
  open,
  onOpenChange,
  contracts,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contracts: ContractListItem[];
}) {
  const queryClient = useQueryClient();
  const [programType, setProgramType] = useState<"LICENSED_SEAT" | "CREDIT_POOL">(
    "LICENSED_SEAT",
  );
  const [contractId, setContractId] = useState<string>("");
  const [name, setName] = useState("");
  const [ratePerSeatRupees, setRatePerSeatRupees] = useState("5000");
  const [cycle, setCycle] = useState<BillingCycle>("MONTHLY");
  const [coveredEngagementsPerCycle, setCoveredEngagementsPerCycle] = useState("");
  const [overageBehavior, setOverageBehavior] =
    useState<OverageBehavior>("BLOCK");
  // 1 credit = ₹1; per-cycle cap is the user-facing input, paise conversion
  // is implicit (credits map to rupees end-to-end).
  const [creditsPerCycle, setCreditsPerCycle] = useState("1000");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setProgramType("LICENSED_SEAT");
    setContractId("");
    setName("");
    setRatePerSeatRupees("5000");
    setCycle("MONTHLY");
    setCoveredEngagementsPerCycle("");
    setOverageBehavior("BLOCK");
    setCreditsPerCycle("1000");
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: (body: CreateProgramBody) => createProgram(orgId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (!contractId) {
      setError("Pick the contract this program attaches to.");
      return;
    }
    if (name.trim().length < 2) {
      setError("Program name must be at least 2 characters.");
      return;
    }
    if (programType === "LICENSED_SEAT") {
      const ratePaise = rupeesToPaise(ratePerSeatRupees);
      if (ratePaise === null) {
        setError("Rate per seat must be a non-negative number (in rupees).");
        return;
      }
      const cap =
        coveredEngagementsPerCycle.trim() === ""
          ? null
          : parseInt(coveredEngagementsPerCycle, 10);
      if (cap !== null && (!Number.isFinite(cap) || cap < 1)) {
        setError("Covered engagements per cycle must be blank or a positive integer.");
        return;
      }
      createMutation.mutate({
        type: "LICENSED_SEAT",
        contractId,
        name: name.trim(),
        licensedSeatConfig: {
          ratePerSeatPaise: ratePaise,
          cycle,
          coveredEngagementsPerCycle: cap,
          overageBehavior,
        },
      });
    } else {
      const credits = Number(creditsPerCycle.trim());
      if (!Number.isFinite(credits) || credits < 1 || !Number.isInteger(credits)) {
        setError("Credits per cycle must be a positive integer.");
        return;
      }
      createMutation.mutate({
        type: "CREDIT_POOL",
        contractId,
        name: name.trim(),
        creditPoolConfig: {
          cycle,
          creditsPerCycle: credits,
        },
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Program</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Program type */}
          <div className="space-y-2">
            <Label>Program type</Label>
            <Select
              value={programType}
              onValueChange={(v) => {
                if (v === "LICENSED_SEAT" || v === "CREDIT_POOL") {
                  setProgramType(v);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["LICENSED_SEAT", "CREDIT_POOL"] as const).map((t) => (
                  <SelectItem key={t} value={t}>
                    {PROGRAM_TYPE_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500">
              {PROGRAM_TYPE_META[programType].description}
            </p>
          </div>

          {/* Contract */}
          <div className="space-y-2">
            <Label>Contract</Label>
            <Select value={contractId} onValueChange={setContractId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    contracts.length === 0
                      ? "No ACTIVE contracts — create one first"
                      : "Pick a contract"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {contracts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {formatContractLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500">
              The program inherits the contract&apos;s billing account and
              currency. Rates below are in ₹ (rupees).
            </p>
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="program-name">Name</Label>
            <Input
              id="program-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q1 Leadership Coaching"
            />
          </div>

          {programType === "LICENSED_SEAT" ? (
            <>
              {/* Rate + cycle — row 1 */}
              <div className="grid grid-cols-[1fr_180px] gap-3">
                <div className="space-y-2">
                  <Label htmlFor="rate-per-seat">Rate per seat (₹)</Label>
                  <Input
                    id="rate-per-seat"
                    type="number"
                    min={0}
                    step={1}
                    value={ratePerSeatRupees}
                    onChange={(e) => setRatePerSeatRupees(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Cycle</Label>
                  <Select
                    value={cycle}
                    onValueChange={(v) => {
                      if (
                        v === "MONTHLY" ||
                        v === "QUARTERLY" ||
                        v === "ANNUAL"
                      ) {
                        setCycle(v);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BILLING_CYCLES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Engagements per cycle — full width so the hint + input
                  breathe instead of wrapping into a 2-col cell. */}
              <div className="space-y-2">
                <Label htmlFor="covered-engagements">
                  Engagements per cycle
                </Label>
                <Input
                  id="covered-engagements"
                  type="number"
                  min={1}
                  value={coveredEngagementsPerCycle}
                  onChange={(e) =>
                    setCoveredEngagementsPerCycle(e.target.value)
                  }
                  placeholder="e.g. 12 — leave blank for unlimited"
                />
                <p className="text-xs text-zinc-500">
                  An engagement is one calendar occurrence — a 1:1 call, a
                  webinar, or one class day. A 4-hour mentoring call counts
                  as 1; a 12-call subscription counts as 12 over the cycle;
                  an 8-week class counts as 8. Per-engagement price cap is
                  separate. Leave blank for unlimited (flat licence).
                </p>
              </div>

              {/* Overage behaviour */}
              <div className="space-y-2">
                <Label>Overage behaviour</Label>
                <Select
                  value={overageBehavior}
                  onValueChange={(v) => {
                    if (
                      v === "BLOCK" ||
                      v === "CHARGE_MEMBER" ||
                      v === "CHARGE_ORG"
                    ) {
                      setOverageBehavior(v);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BLOCK">
                      Block — reject booking once the cap is hit
                    </SelectItem>
                    <SelectItem value="CHARGE_MEMBER">
                      Charge member — learner pays the overage on their own card
                    </SelectItem>
                    <SelectItem value="CHARGE_ORG">
                      Charge org — added to the next invoice
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="credits-per-cycle">
                Credits per cycle (1 credit = ₹1)
              </Label>
              <Input
                id="credits-per-cycle"
                type="number"
                min={1}
                step={1}
                value={creditsPerCycle}
                onChange={(e) => setCreditsPerCycle(e.target.value)}
              />
              <p className="text-xs text-zinc-500">
                Hard cap on bookings per {cycle.toLowerCase()} cycle. Each
                credit equals ₹1; debits stop at the cap unless overage is
                enabled.
              </p>
              {/* TODO(#715, #716): Credit-pool checkout + refund/invoice
                  round-trip is not yet acceptance-tested end-to-end. Keep
                  the option visible (per the 2026-04-27 readiness review
                  recommendation: don't hide, surface) but flag the soak
                  status on the form so operators know what's still in
                  flight before they pick this for a real customer. */}
              <EnterpriseWipBanner
                title="Credit pools — checkout + refund soak in progress"
                description="Schema, lazy debit, and reconcile are wired. Refund-to-pool and consolidated-invoice round-trip still need end-to-end QA before this is sellable to a finance-grade tenant."
                issues={[715, 716]}
              />
            </div>
          )}

          {/* C2 (shipped): overage charging is now wired in checkout —
              CHARGE_MEMBER throws 402 ("OVERAGE_REQUIRES_SEPARATE_PAYMENT")
              so the dashboard can surface a "pay the overage" CTA;
              CHARGE_ORG writes an extra PaymentLeg(source=INVOICE_ACCRUAL,
              amountPaise=marginal) that the monthly invoice cron picks
              up. No banner needed. */}

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

export default function OrgProgramsPage({
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
  const [dialogOpen, setDialogOpen] = useState(false);

  const programs = useQuery({
    queryKey: ["org-programs", orgId],
    queryFn: () => fetchPrograms(orgId),
    enabled: allowed,
  });

  const contracts = useQuery({
    queryKey: ["org-contracts-active", orgId],
    queryFn: () => fetchContracts(orgId),
    enabled: allowed && isAtLeast("MAINTAINER"),
  });

  if (!allowed) return null;

  const programList = programs.data?.data ?? [];
  const contractList = contracts.data?.data ?? [];

  return (
    <>
      <DashboardHeader
        title="Programs"
        subtitle="Typed commercial offerings attached to a Contract. Each Program controls what's covered per assigned member."
        actions={
          isAtLeast("MAINTAINER") && (
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              disabled={contractList.length === 0}
              title={
                contractList.length === 0
                  ? "Create an ACTIVE contract before attaching a Program."
                  : undefined
              }
            >
              <Plus className="h-4 w-4 mr-1" /> New Program
            </Button>
          )
        }
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {programs.isLoading
                ? "Loading…"
                : `${programList.length} program${programList.length === 1 ? "" : "s"}`}
            </CardTitle>
            <CardDescription>
              Active programs show their seat / credit config, current
              assignment count, and attached contract. Per-member assignments
              live inside each program — click <em>View</em> to manage them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {programs.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : programList.length === 0 ? (
              <div className="text-center py-12 text-zinc-500">
                <Briefcase className="h-10 w-10 mx-auto mb-3 text-zinc-300" />
                <p className="text-sm">No programs yet.</p>
                {isAtLeast("MAINTAINER") && contractList.length > 0 && (
                  <p className="text-xs mt-2">
                    Click <strong>New Program</strong> to create one against an
                    active contract.
                  </p>
                )}
                {contractList.length === 0 && isAtLeast("MAINTAINER") && (
                  <p className="text-xs mt-2">
                    Create an ACTIVE contract first — Programs must attach to
                    one.
                  </p>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Config</TableHead>
                    <TableHead>Assignments</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {programList.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {PROGRAM_TYPE_META[p.type].label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-600">
                        {p.type === "LICENSED_SEAT" && p.licensedSeatConfig ? (
                          <>
                            {formatCurrencyAmount(
                              p.licensedSeatConfig.ratePerSeatPaise,
                              "INR",
                            )}{" "}
                            / seat /{" "}
                            {p.licensedSeatConfig.cycle.toLowerCase()} ·{" "}
                            {p.licensedSeatConfig.coveredEngagementsPerCycle ??
                              "unlimited"}{" "}
                            engagements ·{" "}
                            {p.licensedSeatConfig.overageBehavior}
                          </>
                        ) : p.type === "CREDIT_POOL" && p.creditPoolConfig ? (
                          <>
                            {p.creditPoolConfig.creditsPerCycle.toLocaleString(
                              "en-IN",
                            )}{" "}
                            credits / {p.creditPoolConfig.cycle.toLowerCase()}
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{p._count.assignments}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            p.status === "ACTIVE"
                              ? "border-green-300 text-green-800"
                              : p.status === "PAUSED"
                                ? "border-amber-300 text-amber-800"
                                : "border-zinc-300 text-zinc-600"
                          }
                        >
                          {p.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      <CreateProgramDialog
        orgId={orgId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contracts={contractList}
      />
    </>
  );
}
