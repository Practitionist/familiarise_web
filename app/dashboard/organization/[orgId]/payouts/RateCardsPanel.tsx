"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Section } from "@/components/dashboard/Section";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { FieldError } from "@/components/ui/field-error";
import { useToast } from "@/hooks/use-toast";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { humanizeEnum } from "@/lib/ui/tone";

interface RateCard {
  id: string;
  planType: string | null;
  planId: string | null;
  ownerContractId: string | null;
  platformBps: number;
  orgBps: number;
  consultantBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

const PLAN_TYPES = [
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
] as const;
const ALL_PLANS = "ALL";

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

function scopeLabel(card: RateCard): string {
  if (card.ownerContractId) return "Contract";
  if (card.planId) return "One plan";
  if (card.planType) return `${humanizeEnum(card.planType)} plans`;
  return "Organization default";
}

async function sendJson(url: string, method: string, body: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessageFromBody(json, "Couldn't save."));
  return json;
}

function NewSplitForm({ orgId }: Readonly<{ orgId: string }>) {
  const [platform, setPlatform] = useState("");
  const [org, setOrg] = useState("");
  const [expert, setExpert] = useState("");
  const [planType, setPlanType] = useState<string>(ALL_PLANS);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Percent in the form, basis points on the wire (integer, sums to 10000).
  const bps = (v: string) => Math.round(Number(v) * 100);

  const create = useMutation({
    mutationFn: () =>
      sendJson(`/api/organizations/${orgId}/rate-cards`, "POST", {
        platformBps: bps(platform),
        orgBps: bps(org),
        consultantBps: bps(expert),
        planType: planType === ALL_PLANS ? null : planType,
        reason: reason.trim() || undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["org-rate-cards", orgId],
      });
      toast({
        title: "New split in effect",
        description:
          "Bookings from now on settle at this split; earlier ones keep theirs.",
      });
      setPlatform("");
      setOrg("");
      setExpert("");
      setReason("");
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parts = [platform, org, expert].map(bps);
    if (parts.some((p) => !Number.isFinite(p) || p < 0)) {
      setError("Enter a percentage for each share.");
      return;
    }
    if (parts.reduce((a, b) => a + b, 0) !== 10_000) {
      setError("The three shares must add up to 100%.");
      return;
    }
    create.mutate();
  };

  const pctInput = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={0}
        max={100}
        step="0.01"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );

  return (
    <form
      onSubmit={submit}
      className="max-w-3xl space-y-4"
      aria-label="New split"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {pctInput("split-platform", "Platform %", platform, setPlatform)}
        {pctInput("split-org", "Organization %", org, setOrg)}
        {pctInput("split-expert", "Expert %", expert, setExpert)}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="split-plan-type">Applies to</Label>
          <Select value={planType} onValueChange={setPlanType}>
            <SelectTrigger id="split-plan-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PLANS}>Every plan (default)</SelectItem>
              {PLAN_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {humanizeEnum(t)} plans
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="split-reason">Reason (optional)</Label>
          <Input
            id="split-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>
      <FieldError message={error} />
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? "Saving…" : "Start this split now"}
      </Button>
    </form>
  );
}

/**
 * Payouts › Rate cards (#1527 Q6): the platform / organization / expert split.
 * Cards are append-only — a change starts a new card and closes the old one,
 * so settled earnings keep the split they used. Mutations are OWNER +
 * BILLING_ADMIN on the server (`payouts.manage` here).
 */
export function RateCardsPanel({
  orgId,
  canManage,
}: Readonly<{ orgId: string; canManage: boolean }>) {
  const [showHistory, setShowHistory] = useState(false);
  const queryClient = useQueryClient();
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["org-rate-cards", orgId, showHistory],
    queryFn: async (): Promise<RateCard[]> => {
      const res = await fetch(
        `/api/organizations/${orgId}/rate-cards?scope=${showHistory ? "all" : "current"}`,
      );
      if (!res.ok) throw new Error("Failed to load rate cards");
      return ((await res.json()) as { data: RateCard[] }).data;
    },
  });

  const retire = async (card: RateCard) => {
    // A minute ahead: the server refuses an end date in the past.
    await sendJson(
      `/api/organizations/${orgId}/rate-cards/${card.id}`,
      "PATCH",
      {
        effectiveTo: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    await queryClient.invalidateQueries({
      queryKey: ["org-rate-cards", orgId],
    });
  };

  const columns: ResponsiveColumn<RateCard>[] = [
    {
      key: "scope",
      header: "Applies to",
      primary: true,
      cell: (c) => scopeLabel(c),
    },
    {
      key: "split",
      header: "Platform · Org · Expert",
      className: "tabular-nums",
      cell: (c) =>
        `${pct(c.platformBps)} · ${pct(c.orgBps)} · ${pct(c.consultantBps)}`,
    },
    {
      key: "from",
      header: "Since",
      className: "text-muted-foreground",
      cell: (c) => fmtDate(c.effectiveFrom),
    },
    {
      key: "state",
      header: "State",
      cell: (c) =>
        c.effectiveTo && new Date(c.effectiveTo) <= new Date() ? (
          <StatusBadge
            label={`Ended ${fmtDate(c.effectiveTo)}`}
            tone="neutral"
          />
        ) : (
          <StatusBadge label="In effect" tone="success" />
        ),
    },
  ];

  const renderActions = (card: RateCard) =>
    canManage && !card.effectiveTo ? (
      <ConfirmDialog
        title="End this rate card?"
        description="Bookings after this point stop using this split. Earnings already settled keep it."
        confirmLabel="End card"
        tone="destructive"
        onConfirm={() => retire(card)}
        trigger={
          <Button size="sm" variant="ghost">
            End
          </Button>
        }
      />
    ) : null;

  return (
    <>
      <Section
        title="Splits"
        description="How each booking's price divides between the platform, this organization and the delivering expert."
        actions={
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showHistory}
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? "Current only" : "Show history"}
          </Button>
        }
      >
        {isError ? (
          <ErrorState
            title="Couldn't load rate cards"
            onRetry={() => void refetch()}
          />
        ) : (
          <ResponsiveTable<RateCard>
            columns={columns}
            rows={data ?? []}
            getRowId={(c) => c.id}
            rowActions={renderActions}
            isLoading={isPending}
            empty="No rate card yet. Start one below to set how bookings split."
          />
        )}
      </Section>
      {canManage && (
        <Section
          title="Start a new split"
          description="Takes effect now and closes the current card for the same scope."
        >
          <NewSplitForm orgId={orgId} />
        </Section>
      )}
    </>
  );
}
