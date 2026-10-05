"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Briefcase,
  Loader2,
  Users,
  Pencil,
  Lock,
  Trash2,
  Pause,
  Play,
  Ban,
  GitBranchPlus,
} from "lucide-react";
import type {
  BillingCycle,
  FundingSource,
  OverageBehavior,
  ProgramStatus,
  ProgramType,
} from "@prisma/client";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  capabilityOf,
  defaultOverageBehaviorForFunding,
  type ReachableCapability,
} from "@/lib/enterprise/reachable-paths";
import {
  MotivationBanner,
  resolveProgramMotivation,
} from "@/components/organization/MotivationBanner";
import { AdvancedPermutationGate } from "@/components/organization/AdvancedPermutationGate";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Checkbox } from "@/components/ui/checkbox";
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
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { formatCurrencyAmount } from "@/utils/formatting";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { MEMBER_ROLE_LABEL } from "@/lib/labels/org-labels";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";

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
    overageSurchargeBps: number | null;
    priceCapPerEngagementPaise: number | null;
    maxOveragePerCyclePaise: number | null;
    activeSeatCount: number;
  } | null;
  creditPoolConfig: {
    cycle: BillingCycle;
    creditBudgetPerCycle: number;
    overageBehavior: OverageBehavior;
    overageSurchargeBps: number | null;
    priceCapPerEngagementPaise?: number | null;
    maxOveragePerCyclePaise: number | null;
  } | null;
  _count: { assignments: number };
  utilization: {
    activeAssignments: number;
    engagementsUsed: number;
    consumedPaise: number;
  };
}

function programUtilization(
  p: ProgramListItem,
): { used: string; total: string; pct: number | null } | null {
  const { activeAssignments, engagementsUsed, consumedPaise } = p.utilization;
  if (activeAssignments === 0) return null;
  if (p.type === "LICENSED_SEAT") {
    const cap = p.licensedSeatConfig?.coveredEngagementsPerCycle ?? null;
    if (cap === null)
      return { used: String(engagementsUsed), total: "∞", pct: null };
    const total = cap * activeAssignments;
    return {
      used: String(engagementsUsed),
      total: String(total),
      pct:
        total > 0
          ? Math.min(100, Math.ceil((engagementsUsed / total) * 100))
          : null,
    };
  }
  if (p.type === "CREDIT_POOL") {
    const budgetPaise =
      (p.creditPoolConfig?.creditBudgetPerCycle ?? 0) * 100 * activeAssignments;
    return {
      used: formatCurrencyAmount(consumedPaise, "INR"),
      total: budgetPaise > 0 ? formatCurrencyAmount(budgetPaise, "INR") : "∞",
      pct:
        budgetPaise > 0
          ? Math.min(100, Math.ceil((consumedPaise / budgetPaise) * 100))
          : null,
    };
  }
  return null;
}

const OVERAGE_BEHAVIOR_LABEL: Record<OverageBehavior, string> = {
  BLOCK: "Block",
  CHARGE_MEMBER: "Charge member",
  CHARGE_ORG: "Charge org",
};

interface ContractListItem {
  id: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  paymentTermsDays: number;
  billingAccount: { currency: string; fundingSource: string } | null;
  purchaseOrder: { poNumber: string } | null;
}

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

function parseCategoriesInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
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

const COVERED_PLAN_TYPE_OPTIONS = [
  { value: "CONSULTATION", label: "Consultation", description: "1:1 sessions" },
  { value: "CLASS", label: "Class", description: "Group classes" },
  { value: "WEBINAR", label: "Webinar", description: "Live webinars" },
  {
    value: "SUBSCRIPTION",
    label: "Subscription",
    description: "Recurring plans",
  },
] as const;

type CoveredPlanType = (typeof COVERED_PLAN_TYPE_OPTIONS)[number]["value"];

type CreateProgramBody =
  | {
      type: "LICENSED_SEAT";
      contractId: string;
      name: string;
      coveredPlanTypes: CoveredPlanType[];
      allowedCategories: string[];
      licensedSeatConfig: {
        ratePerSeatPaise: number;
        cycle: BillingCycle;
        coveredEngagementsPerCycle: number | null;
        overageBehavior: OverageBehavior;
        overageSurchargeBps: number | null;
        priceCapPerEngagementPaise: number | null;
        maxOveragePerCyclePaise: number | null;
      };
    }
  | {
      type: "CREDIT_POOL";
      contractId: string;
      name: string;
      coveredPlanTypes: CoveredPlanType[];
      allowedCategories: string[];
      creditPoolConfig: {
        cycle: BillingCycle;
        creditBudgetPerCycle: number;
        overageBehavior: OverageBehavior;
        overageSurchargeBps: number | null;
        priceCapPerEngagementPaise: number | null;
        maxOveragePerCyclePaise: number | null;
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

type PatchProgramBody = {
  name?: string;
  status?: ProgramStatus;
  coveredPlanTypes?: CoveredPlanType[];
  allowedCategories?: string[];
  ratePerSeatPaise?: number;
  coveredEngagementsPerCycle?: number | null;
  creditBudgetPerCycle?: number;
  overageBehavior?: OverageBehavior;
  overageSurchargeBps?: number | null;
  priceCapPerEngagementPaise?: number | null;
  maxOveragePerCyclePaise?: number | null;
};

async function patchProgram(
  orgId: string,
  programId: string,
  body: PatchProgramBody,
) {
  const res = await fetch(`/api/organizations/${orgId}/programs/${programId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to update program",
    );
  }
  return json;
}

type SupersedeProgramBody = {
  name?: string;
  coveredPlanTypes?: CoveredPlanType[];
  allowedCategories?: string[];
  ratePerSeatPaise?: number;
  coveredEngagementsPerCycle?: number | null;
  creditBudgetPerCycle?: number;
  overageBehavior?: OverageBehavior;
  overageSurchargeBps?: number | null;
  priceCapPerEngagementPaise?: number | null;
  maxOveragePerCyclePaise?: number | null;
  migrateAssignments?: boolean;
};

async function supersedeProgram(
  orgId: string,
  programId: string,
  body: SupersedeProgramBody,
) {
  const res = await fetch(
    `/api/organizations/${orgId}/programs/${programId}/supersede`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ??
        "Failed to amend and supersede program",
    );
  }
  return json;
}

async function deleteProgram(orgId: string, programId: string) {
  const res = await fetch(`/api/organizations/${orgId}/programs/${programId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(
      (json as { error?: string }).error ?? "Failed to delete program",
    );
  }
}

type ProgramDetail = ProgramListItem & { locked: boolean };

async function fetchProgram(
  orgId: string,
  programId: string,
): Promise<{ program: ProgramDetail }> {
  const res = await fetch(`/api/organizations/${orgId}/programs/${programId}`);
  if (!res.ok) throw new Error("Failed to load program");
  return res.json();
}

// ---------------------------------------------------------------------------
// API layer — assignments
// ---------------------------------------------------------------------------

interface MemberListItem {
  id: string;
  role: string;
  user: { id: string; name: string | null; email: string };
}

interface AssignmentListItem {
  id: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  membership: {
    id: string;
    role: string;
    user: { id: string; name: string | null; email: string };
  };
}

async function fetchMembers(
  orgId: string,
): Promise<{ data: MemberListItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/members?perPage=100`);
  if (!res.ok) throw new Error("Failed to load members");
  return res.json();
}

async function fetchAssignments(
  orgId: string,
  programId: string,
): Promise<{ data: AssignmentListItem[] }> {
  const res = await fetch(
    `/api/organizations/${orgId}/programs/${programId}/assignments`,
  );
  if (!res.ok) throw new Error("Failed to load assignments");
  return res.json();
}

async function endAssignment(
  orgId: string,
  programId: string,
  assignmentId: string,
) {
  const res = await fetch(
    `/api/organizations/${orgId}/programs/${programId}/assignments/${assignmentId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cancel: true }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Couldn't end the assignment.",
    );
  }
}

const PROGRAM_STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "success",
  PAUSED: "caution",
  CANCELLED: "neutral",
};

function ProgramStatusBadge({ status }: Readonly<{ status: string }>) {
  return (
    <StatusBadge
      label={humanizeEnum(status)}
      tone={PROGRAM_STATUS_TONE[status] ?? "neutral"}
    />
  );
}

async function createAssignment(
  orgId: string,
  programId: string,
  body: { membershipId: string; periodStart: string; periodEnd: string },
) {
  const res = await fetch(
    `/api/organizations/${orgId}/programs/${programId}/assignments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (json as { error?: string }).error ?? "Failed to create assignment",
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
      "Pool with a per-cycle credit cap (1 credit = ₹1). Each booking debits credits up to the cap.",
    available: true,
  },
};

const BILLING_CYCLES: BillingCycle[] = ["MONTHLY", "QUARTERLY", "ANNUAL"];

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
  capability,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contracts: ContractListItem[];
  capability: ReachableCapability | null;
}) {
  const queryClient = useQueryClient();
  const [programType, setProgramType] = useState<
    "LICENSED_SEAT" | "CREDIT_POOL"
  >("LICENSED_SEAT");
  const [contractId, setContractId] = useState<string>("");
  const [name, setName] = useState("");
  const [ratePerSeatRupees, setRatePerSeatRupees] = useState("5000");
  const [cycle, setCycle] = useState<BillingCycle>("MONTHLY");
  const [coveredEngagementsPerCycle, setCoveredEngagementsPerCycle] =
    useState("");
  const [overageBehavior, setOverageBehavior] =
    useState<OverageBehavior>("BLOCK");
  const [overageTouched, setOverageTouched] = useState(false);
  const [overageSurchargePct, setOverageSurchargePct] = useState("");
  const [priceCapPerEngagementRupees, setPriceCapPerEngagementRupees] =
    useState("");
  const [maxOveragePerCycleRupees, setMaxOveragePerCycleRupees] = useState("");
  const [creditBudgetPerCycle, setCreditsPerCycle] = useState("1000");
  const [coveredPlanTypes, setCoveredPlanTypes] = useState<CoveredPlanType[]>([
    "CONSULTATION",
  ]);
  const [allowedCategoriesInput, setAllowedCategoriesInput] = useState("");
  const [acknowledgedDiscouraged, setAcknowledgedDiscouraged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedFunding = useMemo<FundingSource | null>(() => {
    const raw = contracts.find((c) => c.id === contractId)?.billingAccount
      ?.fundingSource;
    return raw === "PERSONAL" ||
      raw === "WALLET" ||
      raw === "INVOICE" ||
      raw === "LICENSE"
      ? raw
      : null;
  }, [contracts, contractId]);

  // All program types are unlocked across funding rails once a contract is
  // selected; non-standard combinations are guided via MotivationBanner.
  const reachableTypes = useMemo<Array<"LICENSED_SEAT" | "CREDIT_POOL">>(() => {
    if (!capability || !selectedFunding) return ["LICENSED_SEAT", "CREDIT_POOL"];
    return ["LICENSED_SEAT", "CREDIT_POOL"];
  }, [capability, selectedFunding]);

  const effectiveOverageBehavior: OverageBehavior = overageTouched
    ? overageBehavior
    : defaultOverageBehaviorForFunding(selectedFunding);

  const parsedSurchargeBps = useMemo<number | null>(() => {
    if (effectiveOverageBehavior === "BLOCK" || overageSurchargePct.trim() === "") {
      return null;
    }
    const n = parseFloat(overageSurchargePct);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }, [effectiveOverageBehavior, overageSurchargePct]);

  const motivation = useMemo(
    () =>
      resolveProgramMotivation({
        fundingSource: selectedFunding,
        programType,
        overageBehavior: effectiveOverageBehavior,
        overageSurchargeBps: parsedSurchargeBps,
      }),
    [selectedFunding, programType, effectiveOverageBehavior, parsedSurchargeBps],
  );

  const applyGoldenPath = () => {
    if (selectedFunding === "LICENSE" && programType === "CREDIT_POOL") {
      setProgramType("LICENSED_SEAT");
    }
    const defaultOverage = defaultOverageBehaviorForFunding(selectedFunding);
    setOverageBehavior(defaultOverage);
    setOverageTouched(true);
    setOverageSurchargePct("");
    setAcknowledgedDiscouraged(false);
  };

  const reset = () => {
    setProgramType("LICENSED_SEAT");
    setContractId("");
    setName("");
    setRatePerSeatRupees("5000");
    setCycle("MONTHLY");
    setCoveredEngagementsPerCycle("");
    setOverageBehavior("BLOCK");
    setOverageTouched(false);
    setOverageSurchargePct("");
    setPriceCapPerEngagementRupees("");
    setMaxOveragePerCycleRupees("");
    setCreditsPerCycle("1000");
    setCoveredPlanTypes(["CONSULTATION"]);
    setAllowedCategoriesInput("");
    setAcknowledgedDiscouraged(false);
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
    if (coveredPlanTypes.length === 0) {
      setError("Select at least one appointment type this program covers.");
      return;
    }
    if (motivation.tier === "DISCOURAGED" && !acknowledgedDiscouraged) {
      setError(
        "Please confirm the non-standard commercial configuration or switch to the recommended Golden Path.",
      );
      return;
    }

    let priceCapPerEngagementPaise: number | null = null;
    if (priceCapPerEngagementRupees.trim() !== "") {
      const parsedCap = rupeesToPaise(priceCapPerEngagementRupees);
      if (parsedCap === null || parsedCap < 1) {
        setError(
          "Price cap per engagement must be blank or a positive rupee amount.",
        );
        return;
      }
      priceCapPerEngagementPaise = parsedCap;
    }

    let maxOveragePerCyclePaise: number | null = null;
    let overageSurchargeBps: number | null = null;
    if (effectiveOverageBehavior !== "BLOCK") {
      if (
        programType === "LICENSED_SEAT" &&
        coveredEngagementsPerCycle.trim() === ""
      ) {
        setError(
          "Overage settings have no effect when sessions per cycle is unlimited. Either enter a positive cap or switch overage behaviour to Block.",
        );
        return;
      }
      const parsed = rupeesToPaise(maxOveragePerCycleRupees);
      if (parsed === null || parsed < 1) {
        setError(
          "Max overage per cycle is required when overage charges the org/member — enter a positive rupee ceiling.",
        );
        return;
      }
      maxOveragePerCyclePaise = parsed;

      if (overageSurchargePct.trim() !== "") {
        const pct = parseFloat(overageSurchargePct);
        if (!Number.isFinite(pct) || pct < 0) {
          setError(
            "Overage surcharge must be blank or a non-negative percentage.",
          );
          return;
        }
        overageSurchargeBps = Math.round(pct * 100);
      }
    }

    const allowedCategories = parseCategoriesInput(allowedCategoriesInput);

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
        setError(
          "Covered engagements per cycle must be blank or a positive integer.",
        );
        return;
      }
      createMutation.mutate({
        type: "LICENSED_SEAT",
        contractId,
        name: name.trim(),
        coveredPlanTypes,
        allowedCategories,
        licensedSeatConfig: {
          ratePerSeatPaise: ratePaise,
          cycle,
          coveredEngagementsPerCycle: cap,
          overageBehavior: effectiveOverageBehavior,
          overageSurchargeBps,
          priceCapPerEngagementPaise,
          maxOveragePerCyclePaise,
        },
      });
    } else {
      const credits = Number(creditBudgetPerCycle.trim());
      if (
        !Number.isFinite(credits) ||
        credits < 1 ||
        !Number.isInteger(credits)
      ) {
        setError("Credits per cycle must be a positive integer.");
        return;
      }
      createMutation.mutate({
        type: "CREDIT_POOL",
        contractId,
        name: name.trim(),
        coveredPlanTypes,
        allowedCategories,
        creditPoolConfig: {
          cycle,
          creditBudgetPerCycle: credits,
          overageBehavior: effectiveOverageBehavior,
          overageSurchargeBps,
          priceCapPerEngagementPaise,
          maxOveragePerCyclePaise,
        },
      });
    }
  };

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <ResponsiveModalContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Create Program</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-5">
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
                {reachableTypes.map((t) => (
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

          {selectedFunding && (
            <MotivationBanner
              tier={motivation.tier}
              title={motivation.title}
              message={motivation.message}
              recommendation={motivation.recommendation}
              actionLabel={
                motivation.tier !== "RECOMMENDED"
                  ? "Use Recommended Golden Path"
                  : undefined
              }
              onAction={
                motivation.tier !== "RECOMMENDED" ? applyGoldenPath : undefined
              }
              compact
            />
          )}

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

          {/* Covered plan types */}
          <div className="space-y-2">
            <Label>Covered appointment types</Label>
            <div className="grid grid-cols-2 gap-2">
              {COVERED_PLAN_TYPE_OPTIONS.map((opt) => {
                const checked = coveredPlanTypes.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex items-start gap-2 rounded-md border p-2.5 cursor-pointer hover:bg-zinc-50 transition-colors"
                  >
                    <Checkbox
                      id={`plan-type-${opt.value}`}
                      checked={checked}
                      onCheckedChange={(v) => {
                        setCoveredPlanTypes((prev) =>
                          v
                            ? [...prev, opt.value]
                            : prev.filter((t) => t !== opt.value),
                        );
                      }}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="text-sm font-medium">{opt.label}</span>
                      <p className="text-xs text-zinc-500">{opt.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-zinc-500">
              Only bookings matching a selected type will be covered by this
              program. Select at least one.
            </p>
          </div>

          {/* Allowed categories */}
          <div className="space-y-2">
            <Label htmlFor="allowed-categories">
              Allowed categories (optional)
            </Label>
            <Input
              id="allowed-categories"
              value={allowedCategoriesInput}
              onChange={(e) => setAllowedCategoriesInput(e.target.value)}
              placeholder="e.g. Leadership, Engineering, Product — leave blank for all"
            />
            <p className="text-xs text-zinc-500">
              Comma-separated domain categories this program covers. Leave blank
              to cover all categories.
            </p>
          </div>

          {programType === "LICENSED_SEAT" ? (
            <>
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
                  webinar, or one class day. Leave blank for unlimited (flat
                  licence).
                </p>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-[1fr_180px] gap-3">
              <div className="space-y-2">
                <Label htmlFor="credits-per-cycle">
                  Credits per cycle (1 credit = ₹1)
                </Label>
                <Input
                  id="credits-per-cycle"
                  type="number"
                  min={1}
                  step={1}
                  value={creditBudgetPerCycle}
                  onChange={(e) => setCreditsPerCycle(e.target.value)}
                />
                <p className="text-xs text-zinc-500">
                  Per-cycle credit budget (1 credit = ₹1).
                </p>
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
          )}

          {/* Per-engagement price cap */}
          <div className="space-y-2">
            <Label htmlFor="price-cap-per-engagement">
              Price cap per engagement (₹, optional)
            </Label>
            <Input
              id="price-cap-per-engagement"
              type="number"
              min={1}
              step={1}
              value={priceCapPerEngagementRupees}
              onChange={(e) => setPriceCapPerEngagementRupees(e.target.value)}
              placeholder="e.g. 15000 — leave blank for no per-booking price cap"
            />
            <p className="text-xs text-zinc-500">
              Maximum covered price for any single booking under this program.
            </p>
          </div>

          {/* Overage policy */}
          <div className="space-y-2">
            <Label>Overage behaviour</Label>
            <Select
              value={effectiveOverageBehavior}
              onValueChange={(v) => {
                if (
                  v === "BLOCK" ||
                  v === "CHARGE_MEMBER" ||
                  v === "CHARGE_ORG"
                ) {
                  setOverageBehavior(v);
                  setOverageTouched(true);
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
                <SelectItem value="CHARGE_ORG">
                  Charge org — billed to the organization (invoice or wallet)
                </SelectItem>
                <SelectItem value="CHARGE_MEMBER">
                  Charge member — learner pays the over-cap co-pay at checkout
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500">
              Applies to new bookings from the moment you save. INVOICE
              programmes default to Charge org; other funding rails default to
              Block.
            </p>
          </div>

          {effectiveOverageBehavior !== "BLOCK" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="max-overage">Max overage per cycle (₹)</Label>
                <Input
                  id="max-overage"
                  type="number"
                  min={1}
                  step="1"
                  value={maxOveragePerCycleRupees}
                  onChange={(e) => setMaxOveragePerCycleRupees(e.target.value)}
                  placeholder="e.g. 100000 = ₹1,00,000 ceiling"
                />
                <p className="text-xs text-zinc-500">
                  Hard cap on total over-cap spend this cycle (circuit breaker).
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="overage-surcharge">
                  Overage surcharge (%, optional)
                </Label>
                <Input
                  id="overage-surcharge"
                  type="number"
                  min={0}
                  step="0.01"
                  value={overageSurchargePct}
                  onChange={(e) => setOverageSurchargePct(e.target.value)}
                  placeholder="leave blank for 0% markup"
                />
                <p className="text-xs text-zinc-500">
                  Optional handling markup applied to over-cap portions. Leave
                  blank for 0%.
                </p>
              </div>
            </>
          )}

          {motivation.tier === "DISCOURAGED" && (
            <AdvancedPermutationGate
              motivation={motivation}
              defaultExpanded
              onSelectGoldenPath={applyGoldenPath}
              acknowledged={acknowledgedDiscouraged}
              onAcknowledgeChange={setAcknowledgedDiscouraged}
            >
              <p className="text-xs text-muted-foreground">
                This program uses a non-standard commercial combination. Review
                the operational overhead above and confirm below to proceed.
              </p>
            </AdvancedPermutationGate>
          )}

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
          <Button
            onClick={handleSubmit}
            disabled={
              createMutation.isPending ||
              (motivation.tier === "DISCOURAGED" && !acknowledgedDiscouraged)
            }
          >
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
// Edit-program dialog & Amend/Supersede dialog
// ---------------------------------------------------------------------------

function LockedHint() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-600">
      <Lock className="h-3 w-3" /> Locked — in use
    </span>
  );
}

function EditProgramDialog({
  orgId,
  programId,
  open,
  onOpenChange,
  contracts,
  onOpenSupersede,
}: {
  orgId: string;
  programId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contracts: ContractListItem[];
  onOpenSupersede: (program: ProgramListItem) => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["org-program", orgId, programId],
    queryFn: () => fetchProgram(orgId, programId),
    enabled: open,
  });
  const program = detail.data?.program;
  const locked = program?.locked ?? true;
  const savedSurchargeBps =
    program?.licensedSeatConfig?.overageSurchargeBps ??
    program?.creditPoolConfig?.overageSurchargeBps ??
    null;

  const [name, setName] = useState("");
  const [coveredPlanTypes, setCoveredPlanTypes] = useState<CoveredPlanType[]>(
    [],
  );
  const [allowedCategoriesInput, setAllowedCategoriesInput] = useState("");
  const [ratePerSeatRupees, setRatePerSeatRupees] = useState("");
  const [coveredEngagementsPerCycle, setCoveredEngagementsPerCycle] =
    useState("");
  const [creditBudgetPerCycle, setCreditsPerCycle] = useState("");
  const [priceCapPerEngagementRupees, setPriceCapPerEngagementRupees] =
    useState("");
  const [overageBehavior, setOverageBehavior] =
    useState<OverageBehavior>("BLOCK");
  const [overageSurchargePct, setOverageSurchargePct] = useState("");
  const [maxOveragePerCycleRupees, setMaxOveragePerCycleRupees] = useState("");
  const [acknowledgedDiscouraged, setAcknowledgedDiscouraged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!program) return;
    setName(program.name);
    setCoveredPlanTypes(program.coveredPlanTypes as CoveredPlanType[]);
    setAllowedCategoriesInput((program.allowedCategories ?? []).join(", "));
    setOverageBehavior(
      program.licensedSeatConfig?.overageBehavior ??
        program.creditPoolConfig?.overageBehavior ??
        "BLOCK",
    );
    setOverageSurchargePct(
      savedSurchargeBps === null ? "" : String(savedSurchargeBps / 100),
    );
    const priceCap =
      program.licensedSeatConfig?.priceCapPerEngagementPaise ??
      program.creditPoolConfig?.priceCapPerEngagementPaise ??
      null;
    setPriceCapPerEngagementRupees(
      priceCap === null || priceCap === undefined ? "" : String(priceCap / 100),
    );
    const maxOverage =
      program.licensedSeatConfig?.maxOveragePerCyclePaise ??
      program.creditPoolConfig?.maxOveragePerCyclePaise ??
      null;
    setMaxOveragePerCycleRupees(
      maxOverage === null ? "" : String(maxOverage / 100),
    );
    if (program.licensedSeatConfig) {
      setRatePerSeatRupees(
        String(program.licensedSeatConfig.ratePerSeatPaise / 100),
      );
      setCoveredEngagementsPerCycle(
        program.licensedSeatConfig.coveredEngagementsPerCycle === null
          ? ""
          : String(program.licensedSeatConfig.coveredEngagementsPerCycle),
      );
    }
    if (program.creditPoolConfig) {
      setCreditsPerCycle(String(program.creditPoolConfig.creditBudgetPerCycle));
    }
    setAcknowledgedDiscouraged(false);
    setError(null);
  }, [program, savedSurchargeBps]);

  const contractFunding = useMemo<FundingSource | null>(() => {
    if (!program) return null;
    const raw = contracts.find((c) => c.id === program.contractId)
      ?.billingAccount?.fundingSource;
    return raw === "PERSONAL" ||
      raw === "WALLET" ||
      raw === "INVOICE" ||
      raw === "LICENSE"
      ? raw
      : null;
  }, [contracts, program]);

  const parsedSurchargeBps = useMemo<number | null>(() => {
    if (overageBehavior === "BLOCK" || overageSurchargePct.trim() === "") {
      return null;
    }
    const n = parseFloat(overageSurchargePct);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }, [overageBehavior, overageSurchargePct]);

  const motivation = useMemo(
    () =>
      resolveProgramMotivation({
        fundingSource: contractFunding,
        programType: program?.type ?? null,
        overageBehavior,
        overageSurchargeBps: parsedSurchargeBps,
      }),
    [contractFunding, program?.type, overageBehavior, parsedSurchargeBps],
  );

  const patchMutation = useMutation({
    mutationFn: (body: PatchProgramBody) =>
      patchProgram(orgId, programId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      queryClient.invalidateQueries({
        queryKey: ["org-program", orgId, programId],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (name.trim().length < 2) {
      setError("Program name must be at least 2 characters.");
      return;
    }
    const body: PatchProgramBody = { name: name.trim() };
    if (!locked && program) {
      if (coveredPlanTypes.length === 0) {
        setError("Select at least one appointment type this program covers.");
        return;
      }
      if (motivation.tier === "DISCOURAGED" && !acknowledgedDiscouraged) {
        setError(
          "Please confirm the non-standard commercial configuration before saving.",
        );
        return;
      }
      body.coveredPlanTypes = coveredPlanTypes;
      body.allowedCategories = parseCategoriesInput(allowedCategoriesInput);

      let priceCapPerEngagementPaise: number | null = null;
      if (priceCapPerEngagementRupees.trim() !== "") {
        const parsedCap = rupeesToPaise(priceCapPerEngagementRupees);
        if (parsedCap === null || parsedCap < 1) {
          setError(
            "Price cap per engagement must be blank or a positive rupee amount.",
          );
          return;
        }
        priceCapPerEngagementPaise = parsedCap;
      }
      body.priceCapPerEngagementPaise = priceCapPerEngagementPaise;

      const surchargeBps =
        overageBehavior === "BLOCK" || overageSurchargePct.trim() === ""
          ? null
          : Math.round(parseFloat(overageSurchargePct) * 100);
      if (
        surchargeBps !== null &&
        (!Number.isFinite(surchargeBps) || surchargeBps < 0)
      ) {
        setError(
          "Overage surcharge must be blank or a non-negative percentage.",
        );
        return;
      }
      const savedOverageBehavior =
        program.licensedSeatConfig?.overageBehavior ??
        program.creditPoolConfig?.overageBehavior;
      if (overageBehavior !== savedOverageBehavior) {
        body.overageBehavior = overageBehavior;
      }
      if (surchargeBps !== savedSurchargeBps) {
        body.overageSurchargeBps = surchargeBps;
      }

      let maxOveragePerCyclePaise: number | null = null;
      if (overageBehavior !== "BLOCK") {
        if (
          program.type === "LICENSED_SEAT" &&
          coveredEngagementsPerCycle.trim() === ""
        ) {
          setError(
            "Overage settings have no effect when sessions per cycle is unlimited. Either enter a positive cap or switch overage behaviour to Block.",
          );
          return;
        }
        const parsed = rupeesToPaise(maxOveragePerCycleRupees);
        if (parsed === null || parsed < 1) {
          setError(
            "Max overage per cycle is required when overage charges the org/member — enter a positive rupee ceiling.",
          );
          return;
        }
        maxOveragePerCyclePaise = parsed;
      }
      body.maxOveragePerCyclePaise = maxOveragePerCyclePaise;
      if (program.type === "LICENSED_SEAT") {
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
          setError(
            "Covered engagements per cycle must be blank or a positive integer.",
          );
          return;
        }
        body.ratePerSeatPaise = ratePaise;
        body.coveredEngagementsPerCycle = cap;
      } else {
        const credits = Number(creditBudgetPerCycle.trim());
        if (
          !Number.isFinite(credits) ||
          credits < 1 ||
          !Number.isInteger(credits)
        ) {
          setError("Credits per cycle must be a positive integer.");
          return;
        }
        body.creditBudgetPerCycle = credits;
      }
    }
    patchMutation.mutate(body);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Edit Program</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        {detail.isLoading || !program ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-5">
            {locked && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 space-y-2">
                <p>
                  This program is in use (assignments or bookings exist). Its
                  commercial config is locked for audit integrity — only the
                  display name can be edited in place.
                </p>
                {program.status !== "CANCELLED" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs bg-white border-amber-300 text-amber-900 hover:bg-amber-100"
                    onClick={() => {
                      onOpenChange(false);
                      onOpenSupersede(program);
                    }}
                  >
                    <GitBranchPlus className="h-3.5 w-3.5 mr-1.5" />
                    Amend &amp; Supersede Program
                  </Button>
                )}
              </div>
            )}

            <MotivationBanner
              tier={motivation.tier}
              title={motivation.title}
              message={motivation.message}
              recommendation={motivation.recommendation}
              compact
            />

            {/* Name — always editable */}
            <div className="space-y-2">
              <Label htmlFor="edit-program-name">Name</Label>
              <Input
                id="edit-program-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>
                Program type
                {locked && <LockedHint />}
              </Label>
              <p className="text-sm">{PROGRAM_TYPE_META[program.type].label}</p>
            </div>

            {/* Covered plan types */}
            <div className="space-y-2">
              <Label>
                Covered appointment types
                {locked && <LockedHint />}
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {COVERED_PLAN_TYPE_OPTIONS.map((opt) => {
                  const checked = coveredPlanTypes.includes(opt.value);
                  return (
                    <label
                      key={opt.value}
                      className={`flex items-start gap-2 rounded-md border p-2.5 transition-colors ${
                        locked
                          ? "opacity-60"
                          : "cursor-pointer hover:bg-zinc-50"
                      }`}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          setCoveredPlanTypes((prev) =>
                            v
                              ? [...prev, opt.value]
                              : prev.filter((t) => t !== opt.value),
                          );
                        }}
                        className="mt-0.5"
                      />
                      <div>
                        <span className="text-sm font-medium">{opt.label}</span>
                        <p className="text-xs text-zinc-500">
                          {opt.description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Allowed categories */}
            <div className="space-y-2">
              <Label htmlFor="edit-allowed-categories">
                Allowed categories (optional)
                {locked && <LockedHint />}
              </Label>
              <Input
                id="edit-allowed-categories"
                disabled={locked}
                value={allowedCategoriesInput}
                onChange={(e) => setAllowedCategoriesInput(e.target.value)}
                placeholder="e.g. Leadership, Engineering — leave blank for all"
              />
            </div>

            {program.type === "LICENSED_SEAT" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-rate-per-seat">
                    Rate per seat (₹)
                    {locked && <LockedHint />}
                  </Label>
                  <Input
                    id="edit-rate-per-seat"
                    type="number"
                    min={0}
                    step={1}
                    disabled={locked}
                    value={ratePerSeatRupees}
                    onChange={(e) => setRatePerSeatRupees(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-covered-engagements">
                    Engagements per cycle
                    {locked && <LockedHint />}
                  </Label>
                  <Input
                    id="edit-covered-engagements"
                    type="number"
                    min={1}
                    disabled={locked}
                    value={coveredEngagementsPerCycle}
                    onChange={(e) =>
                      setCoveredEngagementsPerCycle(e.target.value)
                    }
                    placeholder="leave blank for unlimited"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="edit-credits-per-cycle">
                  Credits per cycle (1 credit = ₹1)
                  {locked && <LockedHint />}
                </Label>
                <Input
                  id="edit-credits-per-cycle"
                  type="number"
                  min={1}
                  step={1}
                  disabled={locked}
                  value={creditBudgetPerCycle}
                  onChange={(e) => setCreditsPerCycle(e.target.value)}
                />
              </div>
            )}

            {/* Price cap per engagement */}
            <div className="space-y-2">
              <Label htmlFor="edit-price-cap">
                Price cap per engagement (₹, optional)
                {locked && <LockedHint />}
              </Label>
              <Input
                id="edit-price-cap"
                type="number"
                min={1}
                step={1}
                disabled={locked}
                value={priceCapPerEngagementRupees}
                onChange={(e) =>
                  setPriceCapPerEngagementRupees(e.target.value)
                }
                placeholder="leave blank for no per-booking price cap"
              />
            </div>

            {/* Overage policy */}
            <div className="space-y-2">
              <Label>
                Overage behaviour
                {locked && <LockedHint />}
              </Label>
              <Select
                value={overageBehavior}
                disabled={locked}
                onValueChange={(v) => {
                  if (
                    v === "BLOCK" ||
                    v === "CHARGE_MEMBER" ||
                    v === "CHARGE_ORG"
                  ) {
                    setOverageBehavior(v);
                    setAcknowledgedDiscouraged(false);
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
                  <SelectItem value="CHARGE_ORG">
                    Charge org — billed to the organization (invoice or wallet)
                  </SelectItem>
                  <SelectItem value="CHARGE_MEMBER">
                    Charge member — learner pays the over-cap co-pay at checkout
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {overageBehavior !== "BLOCK" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-max-overage">
                    Max overage per cycle (₹)
                    {locked && <LockedHint />}
                  </Label>
                  <Input
                    id="edit-max-overage"
                    type="number"
                    min={1}
                    step="1"
                    disabled={locked}
                    value={maxOveragePerCycleRupees}
                    onChange={(e) => setMaxOveragePerCycleRupees(e.target.value)}
                    placeholder="e.g. 100000 = ₹1,00,000 ceiling"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-overage-surcharge">
                    Overage surcharge (%, optional)
                    {locked && <LockedHint />}
                  </Label>
                  <Input
                    id="edit-overage-surcharge"
                    type="number"
                    min={0}
                    step="0.01"
                    disabled={locked}
                    value={overageSurchargePct}
                    onChange={(e) => {
                      setOverageSurchargePct(e.target.value);
                      setAcknowledgedDiscouraged(false);
                    }}
                    placeholder="leave blank for 0% markup"
                  />
                </div>
              </>
            )}

            {!locked && motivation.tier === "DISCOURAGED" && (
              <AdvancedPermutationGate
                motivation={motivation}
                defaultExpanded
                acknowledged={acknowledgedDiscouraged}
                onAcknowledgeChange={setAcknowledgedDiscouraged}
              >
                <p className="text-xs text-muted-foreground">
                  Confirm that you understand the operational overhead of this
                  non-standard configuration.
                </p>
              </AdvancedPermutationGate>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              patchMutation.isPending ||
              detail.isLoading ||
              !program ||
              (!locked &&
                motivation.tier === "DISCOURAGED" &&
                !acknowledgedDiscouraged)
            }
          >
            {patchMutation.isPending ? (
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

function SupersedeProgramDialog({
  orgId,
  program,
  open,
  onOpenChange,
  contracts,
}: {
  orgId: string;
  program: ProgramListItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contracts: ContractListItem[];
}) {
  const queryClient = useQueryClient();
  const savedSurchargeBps =
    program.licensedSeatConfig?.overageSurchargeBps ??
    program.creditPoolConfig?.overageSurchargeBps ??
    null;

  const [name, setName] = useState(`${program.name} (Amended)`);
  const [coveredPlanTypes, setCoveredPlanTypes] = useState<CoveredPlanType[]>(
    program.coveredPlanTypes as CoveredPlanType[],
  );
  const [allowedCategoriesInput, setAllowedCategoriesInput] = useState(
    (program.allowedCategories ?? []).join(", "),
  );
  const [ratePerSeatRupees, setRatePerSeatRupees] = useState(
    program.licensedSeatConfig
      ? String(program.licensedSeatConfig.ratePerSeatPaise / 100)
      : "5000",
  );
  const [coveredEngagementsPerCycle, setCoveredEngagementsPerCycle] = useState(
    program.licensedSeatConfig?.coveredEngagementsPerCycle === null ||
      program.licensedSeatConfig?.coveredEngagementsPerCycle === undefined
      ? ""
      : String(program.licensedSeatConfig.coveredEngagementsPerCycle),
  );
  const [creditBudgetPerCycle, setCreditsPerCycle] = useState(
    program.creditPoolConfig
      ? String(program.creditPoolConfig.creditBudgetPerCycle)
      : "1000",
  );
  const [priceCapPerEngagementRupees, setPriceCapPerEngagementRupees] =
    useState(() => {
      const cap =
        program.licensedSeatConfig?.priceCapPerEngagementPaise ??
        program.creditPoolConfig?.priceCapPerEngagementPaise ??
        null;
      return cap ? String(cap / 100) : "";
    });
  const [overageBehavior, setOverageBehavior] = useState<OverageBehavior>(
    program.licensedSeatConfig?.overageBehavior ??
      program.creditPoolConfig?.overageBehavior ??
      "BLOCK",
  );
  const [overageSurchargePct, setOverageSurchargePct] = useState(
    savedSurchargeBps === null ? "" : String(savedSurchargeBps / 100),
  );
  const [maxOveragePerCycleRupees, setMaxOveragePerCycleRupees] = useState(
    () => {
      const maxOv =
        program.licensedSeatConfig?.maxOveragePerCyclePaise ??
        program.creditPoolConfig?.maxOveragePerCyclePaise ??
        null;
      return maxOv ? String(maxOv / 100) : "";
    },
  );
  const [migrateAssignments, setMigrateAssignments] = useState(true);
  const [acknowledgedDiscouraged, setAcknowledgedDiscouraged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contractFunding = useMemo<FundingSource | null>(() => {
    const raw = contracts.find((c) => c.id === program.contractId)
      ?.billingAccount?.fundingSource;
    return raw === "PERSONAL" ||
      raw === "WALLET" ||
      raw === "INVOICE" ||
      raw === "LICENSE"
      ? raw
      : null;
  }, [contracts, program.contractId]);

  const parsedSurchargeBps = useMemo<number | null>(() => {
    if (overageBehavior === "BLOCK" || overageSurchargePct.trim() === "") {
      return null;
    }
    const n = parseFloat(overageSurchargePct);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }, [overageBehavior, overageSurchargePct]);

  const motivation = useMemo(
    () =>
      resolveProgramMotivation({
        fundingSource: contractFunding,
        programType: program.type,
        overageBehavior,
        overageSurchargeBps: parsedSurchargeBps,
      }),
    [contractFunding, program.type, overageBehavior, parsedSurchargeBps],
  );

  const supersedeMutation = useMutation({
    mutationFn: (body: SupersedeProgramBody) =>
      supersedeProgram(orgId, program.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      queryClient.invalidateQueries({
        queryKey: ["org-program", orgId, program.id],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (name.trim().length < 2) {
      setError("Successor program name must be at least 2 characters.");
      return;
    }
    if (coveredPlanTypes.length === 0) {
      setError("Select at least one appointment type this program covers.");
      return;
    }
    if (motivation.tier === "DISCOURAGED" && !acknowledgedDiscouraged) {
      setError(
        "Please confirm the non-standard commercial configuration before superseding.",
      );
      return;
    }

    let priceCapPerEngagementPaise: number | null = null;
    if (priceCapPerEngagementRupees.trim() !== "") {
      const parsedCap = rupeesToPaise(priceCapPerEngagementRupees);
      if (parsedCap === null || parsedCap < 1) {
        setError(
          "Price cap per engagement must be blank or a positive rupee amount.",
        );
        return;
      }
      priceCapPerEngagementPaise = parsedCap;
    }

    let maxOveragePerCyclePaise: number | null = null;
    let overageSurchargeBps: number | null = null;
    if (overageBehavior !== "BLOCK") {
      if (
        program.type === "LICENSED_SEAT" &&
        coveredEngagementsPerCycle.trim() === ""
      ) {
        setError(
          "Overage settings have no effect when sessions per cycle is unlimited. Either enter a positive cap or switch overage behaviour to Block.",
        );
        return;
      }
      const parsed = rupeesToPaise(maxOveragePerCycleRupees);
      if (parsed === null || parsed < 1) {
        setError(
          "Max overage per cycle is required when overage charges the org/member — enter a positive rupee ceiling.",
        );
        return;
      }
      maxOveragePerCyclePaise = parsed;

      if (overageSurchargePct.trim() !== "") {
        const pct = parseFloat(overageSurchargePct);
        if (!Number.isFinite(pct) || pct < 0) {
          setError(
            "Overage surcharge must be blank or a non-negative percentage.",
          );
          return;
        }
        overageSurchargeBps = Math.round(pct * 100);
      }
    }

    const body: SupersedeProgramBody = {
      name: name.trim(),
      coveredPlanTypes,
      allowedCategories: parseCategoriesInput(allowedCategoriesInput),
      overageBehavior,
      overageSurchargeBps,
      priceCapPerEngagementPaise,
      maxOveragePerCyclePaise,
      migrateAssignments,
    };

    if (program.type === "LICENSED_SEAT") {
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
        setError(
          "Covered engagements per cycle must be blank or a positive integer.",
        );
        return;
      }
      body.ratePerSeatPaise = ratePaise;
      body.coveredEngagementsPerCycle = cap;
    } else {
      const credits = Number(creditBudgetPerCycle.trim());
      if (
        !Number.isFinite(credits) ||
        credits < 1 ||
        !Number.isInteger(credits)
      ) {
        setError("Credits per cycle must be a positive integer.");
        return;
      }
      body.creditBudgetPerCycle = credits;
    }

    supersedeMutation.mutate(body);
  };

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>
            Amend &amp; Supersede — {program.name}
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <p className="text-xs text-zinc-600 rounded-md border bg-zinc-50 p-3">
            Creates an amended successor program under the same contract,
            permanently cancels and archives{" "}
            <strong>{program.name}</strong> to preserve historical audit trails,
            and optionally migrates all live member assignments to the new
            program in one atomic step.
          </p>

          <MotivationBanner
            tier={motivation.tier}
            title={motivation.title}
            message={motivation.message}
            recommendation={motivation.recommendation}
            compact
          />

          <div className="space-y-2">
            <Label htmlFor="supersede-name">Successor program name</Label>
            <Input
              id="supersede-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Covered appointment types</Label>
            <div className="grid grid-cols-2 gap-2">
              {COVERED_PLAN_TYPE_OPTIONS.map((opt) => {
                const checked = coveredPlanTypes.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex items-start gap-2 rounded-md border p-2.5 cursor-pointer hover:bg-zinc-50"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        setCoveredPlanTypes((prev) =>
                          v
                            ? [...prev, opt.value]
                            : prev.filter((t) => t !== opt.value),
                        );
                      }}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="text-sm font-medium">{opt.label}</span>
                      <p className="text-xs text-zinc-500">{opt.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="supersede-categories">
              Allowed categories (optional)
            </Label>
            <Input
              id="supersede-categories"
              value={allowedCategoriesInput}
              onChange={(e) => setAllowedCategoriesInput(e.target.value)}
              placeholder="leave blank for all categories"
            />
          </div>

          {program.type === "LICENSED_SEAT" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="supersede-rate">Rate per seat (₹)</Label>
                <Input
                  id="supersede-rate"
                  type="number"
                  min={0}
                  step={1}
                  value={ratePerSeatRupees}
                  onChange={(e) => setRatePerSeatRupees(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="supersede-engagements">
                  Engagements per cycle
                </Label>
                <Input
                  id="supersede-engagements"
                  type="number"
                  min={1}
                  value={coveredEngagementsPerCycle}
                  onChange={(e) =>
                    setCoveredEngagementsPerCycle(e.target.value)
                  }
                  placeholder="blank = unlimited"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="supersede-credits">
                Credits per cycle (1 credit = ₹1)
              </Label>
              <Input
                id="supersede-credits"
                type="number"
                min={1}
                step={1}
                value={creditBudgetPerCycle}
                onChange={(e) => setCreditsPerCycle(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="supersede-price-cap">
              Price cap per engagement (₹, optional)
            </Label>
            <Input
              id="supersede-price-cap"
              type="number"
              min={1}
              step={1}
              value={priceCapPerEngagementRupees}
              onChange={(e) => setPriceCapPerEngagementRupees(e.target.value)}
              placeholder="leave blank for no per-booking price cap"
            />
          </div>

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
                  setAcknowledgedDiscouraged(false);
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
                <SelectItem value="CHARGE_ORG">
                  Charge org — billed to the organization
                </SelectItem>
                <SelectItem value="CHARGE_MEMBER">
                  Charge member — learner pays the over-cap co-pay
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {overageBehavior !== "BLOCK" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="supersede-max-overage">
                  Max overage per cycle (₹)
                </Label>
                <Input
                  id="supersede-max-overage"
                  type="number"
                  min={1}
                  step="1"
                  value={maxOveragePerCycleRupees}
                  onChange={(e) => setMaxOveragePerCycleRupees(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="supersede-surcharge">
                  Overage surcharge (%)
                </Label>
                <Input
                  id="supersede-surcharge"
                  type="number"
                  min={0}
                  step="0.01"
                  value={overageSurchargePct}
                  onChange={(e) => {
                    setOverageSurchargePct(e.target.value);
                    setAcknowledgedDiscouraged(false);
                  }}
                  placeholder="0%"
                />
              </div>
            </div>
          )}

          <label className="flex items-start gap-2.5 rounded-md border p-3 cursor-pointer hover:bg-zinc-50">
            <Checkbox
              checked={migrateAssignments}
              onCheckedChange={(v) => setMigrateAssignments(v === true)}
              className="mt-0.5"
            />
            <div className="text-xs">
              <span className="font-medium text-zinc-900">
                Migrate active member assignments automatically
              </span>
              <p className="text-zinc-500 mt-0.5">
                Moves all currently active member assignments from{" "}
                {program.name} to the amended program.
              </p>
            </div>
          </label>

          {motivation.tier === "DISCOURAGED" && (
            <AdvancedPermutationGate
              motivation={motivation}
              defaultExpanded
              acknowledged={acknowledgedDiscouraged}
              onAcknowledgeChange={setAcknowledgedDiscouraged}
            >
              <p className="text-xs text-muted-foreground">
                Confirm this non-standard configuration before superseding.
              </p>
            </AdvancedPermutationGate>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              supersedeMutation.isPending ||
              (motivation.tier === "DISCOURAGED" && !acknowledgedDiscouraged)
            }
          >
            {supersedeMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" /> Superseding…
              </>
            ) : (
              "Amend & Supersede"
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}

// ---------------------------------------------------------------------------
// Manage-program dialog with assign learner (#741)
// ---------------------------------------------------------------------------

/** Live = not ended by status or by date; only those can be unassigned. */
function isLiveAssignment(a: AssignmentListItem): boolean {
  return a.status === "ACTIVE" && new Date(a.periodEnd).getTime() >= Date.now();
}

function AssignmentStateBadge({
  assignment: a,
}: Readonly<{ assignment: AssignmentListItem }>) {
  if (a.status !== "ACTIVE") {
    return (
      <StatusBadge label={humanizeEnum(a.status)} tone="neutral" size="sm" />
    );
  }
  const now = Date.now();
  if (new Date(a.periodEnd).getTime() < now) {
    return <StatusBadge label="Expired" tone="neutral" size="sm" />;
  }
  if (new Date(a.periodStart).getTime() > now) {
    return <StatusBadge label="Upcoming" tone="info" size="sm" />;
  }
  return <StatusBadge label="Active" tone="success" size="sm" />;
}

function ManageProgramDialog({
  orgId,
  program,
  open,
  onOpenChange,
  canAssign,
  canManage,
  onOpenSupersede,
}: {
  orgId: string;
  program: ProgramListItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canAssign: boolean;
  canManage: boolean;
  onOpenSupersede: (program: ProgramListItem) => void;
}) {
  const queryClient = useQueryClient();
  const [membershipId, setMembershipId] = useState("");
  const [periodStart, setPeriodStart] = useState(() =>
    new Date().toLocaleDateString("en-CA"),
  );
  const [periodEnd, setPeriodEnd] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toLocaleDateString("en-CA");
  });
  const [assignError, setAssignError] = useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => fetchMembers(orgId),
    enabled: open && canAssign,
  });

  const assignments = useQuery({
    queryKey: ["program-assignments", orgId, program.id],
    queryFn: () => fetchAssignments(orgId, program.id),
    enabled: open,
  });

  const assignMutation = useMutation({
    mutationFn: (body: {
      membershipId: string;
      periodStart: string;
      periodEnd: string;
    }) => createAssignment(orgId, program.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["program-assignments", orgId, program.id],
      });
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      setMembershipId("");
      setAssignError(null);
    },
    onError: (err: Error) => setAssignError(err.message),
  });

  const statusMutation = useMutation({
    mutationFn: (status: ProgramStatus) =>
      patchProgram(orgId, program.id, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      queryClient.invalidateQueries({
        queryKey: ["org-program", orgId, program.id],
      });
      setLifecycleError(null);
    },
    onError: (err: Error) => setLifecycleError(err.message),
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteMutation = useMutation({
    mutationFn: () => deleteProgram(orgId, program.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
      setConfirmDelete(false);
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setConfirmDelete(false);
      setDeleteError(err.message);
    },
  });

  const handleAssign = () => {
    setAssignError(null);
    if (!membershipId) {
      setAssignError("Select a member to assign.");
      return;
    }
    if (!periodStart || !periodEnd) {
      setAssignError("Both period start and end dates are required.");
      return;
    }
    if (new Date(periodEnd) <= new Date(periodStart)) {
      setAssignError("Period end must be after period start.");
      return;
    }
    assignMutation.mutate({ membershipId, periodStart, periodEnd });
  };

  const memberList = members.data?.data ?? [];
  const assignmentList = assignments.data?.data ?? [];
  const assignableMembers = memberList.filter((m) =>
    ["LEARNER", "MANAGER", "MAINTAINER", "OWNER"].includes(m.role),
  );

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>
            Manage Program — {program.name}
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>

        {/* Program info summary & lifecycle controls */}
        <div className="rounded-md border p-3 space-y-2 text-sm">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex gap-2 flex-wrap">
              <Badge variant="secondary">
                {PROGRAM_TYPE_META[program.type].label}
              </Badge>
              <ProgramStatusBadge status={program.status} />
            </div>

            {canManage && program.status !== "CANCELLED" && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {program.status === "ACTIVE" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={statusMutation.isPending}
                    onClick={() => statusMutation.mutate("PAUSED")}
                  >
                    <Pause className="h-3.5 w-3.5 mr-1" /> Pause
                  </Button>
                )}
                {program.status === "PAUSED" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={statusMutation.isPending}
                    onClick={() => statusMutation.mutate("ACTIVE")}
                  >
                    <Play className="h-3.5 w-3.5 mr-1" /> Resume
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenSupersede(program);
                  }}
                >
                  <GitBranchPlus className="h-3.5 w-3.5 mr-1" /> Amend &amp;
                  Supersede
                </Button>
                <ConfirmDialog
                  title="Cancel this program?"
                  description={`Cancelling ${program.name} stops all future bookings under this program. Existing bookings and ledger records remain intact.`}
                  confirmLabel="Cancel program"
                  tone="destructive"
                  onConfirm={async () => {
                    await patchProgram(orgId, program.id, {
                      status: "CANCELLED",
                    });
                    void queryClient.invalidateQueries({
                      queryKey: ["org-programs", orgId],
                    });
                    onOpenChange(false);
                  }}
                  trigger={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-red-200 text-red-700 hover:bg-red-50"
                      disabled={statusMutation.isPending}
                    >
                      <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
                    </Button>
                  }
                />
              </div>
            )}
          </div>
          {program.coveredPlanTypes.length > 0 && (
            <p className="text-xs text-zinc-500">
              Covers:{" "}
              {program.coveredPlanTypes
                .map((t) => t.charAt(0) + t.slice(1).toLowerCase())
                .join(", ")}
              {program.allowedCategories &&
                program.allowedCategories.length > 0 &&
                ` · Categories: ${program.allowedCategories.join(", ")}`}
            </p>
          )}
          {lifecycleError && (
            <p className="text-xs text-red-600">{lifecycleError}</p>
          )}
        </div>

        {/* Assign learner form */}
        {canAssign && program.status === "ACTIVE" && (
          <div className="space-y-3 rounded-md border p-4">
            <h4 className="text-sm font-semibold flex items-center gap-1.5">
              <Users className="h-4 w-4" /> Assign a member
            </h4>
            <div className="space-y-2">
              <Label>Member</Label>
              <Select value={membershipId} onValueChange={setMembershipId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      members.isLoading
                        ? "Loading members…"
                        : members.isError
                          ? "Failed to load members"
                          : assignableMembers.length === 0
                            ? "No assignable members"
                            : "Pick a member"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {assignableMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.user.name ?? m.user.email} (
                      {MEMBER_ROLE_LABEL[
                        m.role as keyof typeof MEMBER_ROLE_LABEL
                      ] ?? humanizeEnum(m.role)}
                      )
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="period-start">Period start</Label>
                <Input
                  id="period-start"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="period-end">Period end</Label>
                <Input
                  id="period-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
            {assignError && (
              <p className="text-sm text-red-600">{assignError}</p>
            )}
            <Button
              size="sm"
              onClick={handleAssign}
              disabled={assignMutation.isPending}
            >
              {assignMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1" /> Assigning…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1" /> Assign
                </>
              )}
            </Button>
          </div>
        )}

        {/* Current assignments list */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            Assignments ({assignmentList.length})
          </h4>
          {assignments.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : assignmentList.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No members assigned yet. Use the form above to assign a learner.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignmentList.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-sm">
                      {a.membership.user.name ?? a.membership.user.email}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">
                        {MEMBER_ROLE_LABEL[
                          a.membership.role as keyof typeof MEMBER_ROLE_LABEL
                        ] ?? humanizeEnum(a.membership.role)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-zinc-600">
                      {new Date(a.periodStart).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        timeZone: "UTC",
                      })}
                      {" → "}
                      {new Date(a.periodEnd).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </TableCell>
                    <TableCell>
                      <AssignmentStateBadge assignment={a} />
                    </TableCell>
                    <TableCell className="text-right">
                      {canAssign && isLiveAssignment(a) && (
                        <ConfirmDialog
                          title="End this assignment?"
                          description={`${a.membership.user.name ?? a.membership.user.email} stops drawing on ${program.name} now. Sessions already booked and the usage record stay as they are.`}
                          confirmLabel="End assignment"
                          tone="destructive"
                          onConfirm={async () => {
                            await endAssignment(orgId, program.id, a.id);
                            void queryClient.invalidateQueries({
                              queryKey: [
                                "program-assignments",
                                orgId,
                                program.id,
                              ],
                            });
                            void queryClient.invalidateQueries({
                              queryKey: ["org-programs", orgId],
                            });
                          }}
                          trigger={
                            <Button variant="ghost" size="sm">
                              Unassign
                            </Button>
                          }
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {canManage && assignments.isSuccess && assignmentList.length === 0 && (
          <div className="space-y-2 rounded-md border border-red-200 p-4">
            <h4 className="text-sm font-semibold text-red-700">
              Delete program
            </h4>
            <p className="text-xs text-zinc-500">
              This program has no assignments. If it was created by mistake,
              delete it instead of leaving a terminated row behind. Programs
              with assignments or booking history can only be paused or
              cancelled.
            </p>
            {deleteError && (
              <p className="text-sm text-red-600">{deleteError}</p>
            )}
            <Button
              size="sm"
              variant="outline"
              className="border-red-300 text-red-700 hover:bg-red-50"
              onClick={() => setConfirmDelete(true)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-1" /> Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-1" /> Delete program
                </>
              )}
            </Button>
          </div>
        )}

        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete program?</AlertDialogTitle>
              <AlertDialogDescription>
                Permanently delete{" "}
                <span className="font-medium">{program.name}</span>? This is
                only possible because no members were ever assigned. The
                deletion is recorded in the audit log.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ResponsiveModalContent>
    </ResponsiveModal>
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
  const queryClient = useQueryClient();
  const { can, canSponsor, canHost } = useOrgRole(orgId);
  const capability = capabilityOf(canSponsor, canHost);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "programs.read",
    canSponsor: true,
  });
  const canManage = can("programs.manage");
  const canAssign = can("programs.assign");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managingProgram, setManagingProgram] =
    useState<ProgramListItem | null>(null);
  const [editingProgram, setEditingProgram] = useState<ProgramListItem | null>(
    null,
  );
  const [supersedingProgram, setSupersedingProgram] =
    useState<ProgramListItem | null>(null);

  const programs = useQuery({
    queryKey: ["org-programs", orgId],
    queryFn: () => fetchPrograms(orgId),
    enabled: allowed,
  });

  const contracts = useQuery({
    queryKey: ["org-contracts-active", orgId],
    queryFn: () => fetchContracts(orgId),
    enabled: allowed && canManage,
  });

  const rowStatusMutation = useMutation({
    mutationFn: ({
      programId,
      status,
    }: {
      programId: string;
      status: ProgramStatus;
    }) => patchProgram(orgId, programId, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org-programs", orgId] });
    },
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
          canManage && (
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
              live inside each program — click <em>Manage</em> or <em>View</em>{" "}
              to manage them.
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
                {canManage && contractList.length > 0 && (
                  <p className="text-xs mt-2">
                    Click <strong>New Program</strong> to create one against an
                    active contract.
                  </p>
                )}
                {contractList.length === 0 && canManage && (
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
                    <TableHead>Covers</TableHead>
                    <TableHead>Config</TableHead>
                    <TableHead>Assignments</TableHead>
                    <TableHead>Utilization</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
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
                        {p.coveredPlanTypes.length > 0 ? (
                          p.coveredPlanTypes
                            .map((t) => t.charAt(0) + t.slice(1).toLowerCase())
                            .join(", ")
                        ) : (
                          <span className="text-zinc-400 italic">None</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-zinc-600">
                        {p.type === "LICENSED_SEAT" && p.licensedSeatConfig ? (
                          <>
                            {formatCurrencyAmount(
                              p.licensedSeatConfig.ratePerSeatPaise,
                              "INR",
                            )}{" "}
                            / seat / {p.licensedSeatConfig.cycle.toLowerCase()}{" "}
                            ·{" "}
                            {p.licensedSeatConfig.coveredEngagementsPerCycle ??
                              "unlimited"}{" "}
                            engagements ·{" "}
                            {
                              OVERAGE_BEHAVIOR_LABEL[
                                p.licensedSeatConfig.overageBehavior
                              ]
                            }
                          </>
                        ) : p.type === "CREDIT_POOL" && p.creditPoolConfig ? (
                          <>
                            {p.creditPoolConfig.creditBudgetPerCycle.toLocaleString(
                              "en-IN",
                            )}{" "}
                            credits (
                            {formatCurrencyAmount(
                              p.creditPoolConfig.creditBudgetPerCycle * 100,
                              "INR",
                            )}{" "}
                            cap) / {p.creditPoolConfig.cycle.toLowerCase()} ·{" "}
                            {
                              OVERAGE_BEHAVIOR_LABEL[
                                p.creditPoolConfig.overageBehavior
                              ]
                            }
                            <span className="block text-[10px] text-zinc-400">
                              1 credit = ₹1 = 100 paise
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{p._count.assignments}</TableCell>
                      <TableCell className="text-xs">
                        {(() => {
                          const u = programUtilization(p);
                          if (!u)
                            return <span className="text-zinc-400">—</span>;
                          return (
                            <span
                              className={
                                u.pct !== null && u.pct >= 80
                                  ? "font-medium text-amber-700"
                                  : "text-zinc-600"
                              }
                            >
                              {u.used} / {u.total}
                              {u.pct !== null ? ` (${u.pct}%)` : ""}
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <ProgramStatusBadge status={p.status} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 flex-wrap">
                          {canManage && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setEditingProgram(p)}
                              >
                                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                              </Button>
                              {p.status === "ACTIVE" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={rowStatusMutation.isPending}
                                  onClick={() =>
                                    rowStatusMutation.mutate({
                                      programId: p.id,
                                      status: "PAUSED",
                                    })
                                  }
                                >
                                  <Pause className="h-3.5 w-3.5 mr-1" /> Pause
                                </Button>
                              )}
                              {p.status === "PAUSED" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={rowStatusMutation.isPending}
                                  onClick={() =>
                                    rowStatusMutation.mutate({
                                      programId: p.id,
                                      status: "ACTIVE",
                                    })
                                  }
                                >
                                  <Play className="h-3.5 w-3.5 mr-1" /> Resume
                                </Button>
                              )}
                              {p.status !== "CANCELLED" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setSupersedingProgram(p)}
                                  title="Amend rates or caps by creating a successor program and migrating assignments"
                                >
                                  <GitBranchPlus className="h-3.5 w-3.5 mr-1" />{" "}
                                  Amend
                                </Button>
                              )}
                            </>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setManagingProgram(p)}
                          >
                            <Users className="h-3.5 w-3.5 mr-1" />{" "}
                            {canAssign ? "Manage" : "View"}
                          </Button>
                        </div>
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
        capability={capability}
      />

      {editingProgram && (
        <EditProgramDialog
          orgId={orgId}
          programId={editingProgram.id}
          open={!!editingProgram}
          onOpenChange={(v) => {
            if (!v) setEditingProgram(null);
          }}
          contracts={contractList}
          onOpenSupersede={(p) => setSupersedingProgram(p)}
        />
      )}

      {supersedingProgram && (
        <SupersedeProgramDialog
          orgId={orgId}
          program={supersedingProgram}
          open={!!supersedingProgram}
          onOpenChange={(v) => {
            if (!v) setSupersedingProgram(null);
          }}
          contracts={contractList}
        />
      )}

      {managingProgram && (
        <ManageProgramDialog
          orgId={orgId}
          program={managingProgram}
          open={!!managingProgram}
          onOpenChange={(v) => {
            if (!v) setManagingProgram(null);
          }}
          canAssign={canAssign}
          canManage={canManage}
          onOpenSupersede={(p) => setSupersedingProgram(p)}
        />
      )}
    </>
  );
}
