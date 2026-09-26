"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { FundingSource, OrgStatus } from "@prisma/client";

import {
  deriveActivationChecklist,
  deriveActionCenter,
  type ActionItem,
  type OrgActivationSnapshot,
} from "@/lib/enterprise/org-activation";
import { canOpenOrgPage } from "@/lib/dashboard/nav/organization";
import { ActionRequiredPanel } from "@/components/dashboard/ActionRequiredPanel";
import { Section } from "@/components/dashboard/Section";
import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useOrgRole } from "../useOrgRole";

// Shaped to match GET /api/organizations/[orgId]/analytics.
interface OrgAnalytics {
  status: OrgStatus;
  capabilities: {
    canSponsor: boolean;
    canHost: boolean;
    fundingSource: FundingSource | null;
    currency: string | null;
  };
  activation: {
    hasContract: boolean;
    hasActiveContract: boolean;
    contractExpiringSoonCount: number;
    kybVerified: boolean;
    pendingOverageCount: number;
    pendingOveragePaise: number;
    stuckPayoutCount: number;
    creditPoolMaxUtilizationPct: number | null;
    memberBilledOverageProgramNames: string[];
  };
  members: { total: number; active: number };
  programs: { total: number; active: number; activeAssignments: number };
  wallet: { balancePaise: number } | null;
  invoices: {
    outstandingCount: number;
    outstandingPaise: number;
    pastDueCount: number;
  } | null;
  subscription: unknown;
}

interface ActivityItem {
  category: string;
  description: string;
  createdAt: string;
}

async function fetchAnalytics(orgId: string): Promise<OrgAnalytics> {
  const res = await fetch(`/api/organizations/${orgId}/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

async function fetchActivity(
  orgId: string,
): Promise<{ activity: ActivityItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/activity?limit=5`);
  if (!res.ok) throw new Error("Failed to load activity");
  const json = await res.json();
  return { activity: json.data ?? [] };
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Map the analytics payload → the pure activation snapshot. */
function toActivationSnapshot(data: OrgAnalytics): OrgActivationSnapshot {
  return {
    status: data.status,
    canSponsor: data.capabilities.canSponsor,
    canHost: data.capabilities.canHost,
    fundingSource: data.capabilities.fundingSource,
    memberCount: data.members.total,
    activeProgramCount: data.programs.active,
    activeAssignmentCount: data.programs.activeAssignments,
    billingConfigured:
      data.wallet !== null ||
      data.invoices !== null ||
      data.subscription !== null,
    hasContract: data.activation.hasContract,
    hasActiveContract: data.activation.hasActiveContract,
    kybVerified: data.activation.kybVerified,
    pastDueInvoiceCount: data.invoices?.pastDueCount ?? 0,
    outstandingInvoicePaise: data.invoices?.outstandingPaise ?? 0,
    contractExpiringSoonCount: data.activation.contractExpiringSoonCount,
    pendingOverageCount: data.activation.pendingOverageCount,
    pendingOveragePaise: data.activation.pendingOveragePaise,
    stuckPayoutCount: data.activation.stuckPayoutCount,
    walletLowBalancePaise: data.wallet ? data.wallet.balancePaise : null,
    creditPoolMaxUtilizationPct: data.activation.creditPoolMaxUtilizationPct,
    memberBilledOverageProgramNames:
      data.activation.memberBilledOverageProgramNames,
  };
}

const SEVERITY_ORDER: Record<ActionItem["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function Checklist({
  steps,
}: Readonly<{ steps: ReturnType<typeof deriveActivationChecklist> }>) {
  const done = steps.filter((s) => s.done).length;
  return (
    <Section
      title={`Get started — ${done} of ${steps.length} done`}
      variant="card"
    >
      <Progress value={(done / steps.length) * 100} className="mb-4 h-2" />
      <ul className="space-y-1">
        {steps.map((step) => (
          <li key={step.key}>
            <Link
              href={step.href}
              className="flex items-center gap-3 rounded-lg p-2 text-sm transition-colors hover:bg-muted"
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  step.done ? "border-green-600 bg-green-600" : "border-border"
                }`}
              >
                {step.done && <Check className="h-3 w-3 text-white" />}
              </span>
              <span
                className={
                  step.done ? "text-muted-foreground line-through" : ""
                }
              >
                {step.label}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * OWNER / MAINTAINER / MANAGER overview: the action centre and checklist,
 * every CTA filtered to pages this role can open (#1762-11), a slim figures
 * row (money read-only for MANAGER) and recent activity. Fuller figures live
 * on Analytics.
 */
export function OperatorHome({ orgId }: Readonly<{ orgId: string }>) {
  const { role, canSponsor, canHost, can, isAtLeast } = useOrgRole(orgId);
  const analytics = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
  });
  const activity = useQuery({
    queryKey: ["org-activity", orgId],
    queryFn: () => fetchActivity(orgId),
  });

  const viewer = {
    role,
    canSponsor,
    canHost,
    consultantProfileId: null,
  };
  const opens = (href: string) => canOpenOrgPage(viewer, href);
  const base = `/dashboard/organization/${orgId}`;
  const data = analytics.data;
  const snapshot = data ? toActivationSnapshot(data) : null;
  const actionItems = snapshot
    ? deriveActionCenter(snapshot, orgId)
        .filter((item) => opens(item.ctaHref))
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    : [];
  const checklist = snapshot
    ? deriveActivationChecklist(snapshot, orgId).filter((s) => opens(s.href))
    : [];
  const showChecklist =
    isAtLeast("MAINTAINER") &&
    checklist.length > 0 &&
    checklist.some((s) => !s.done);

  const currency = data?.capabilities.currency ?? "INR";
  const quickActions = [
    {
      label: "Invite members",
      href: `${base}/members?tab=invitations`,
      show: can("invitations.manage"),
    },
    {
      label: "Create a program",
      href: `${base}/programs`,
      show: canSponsor && can("programs.manage"),
    },
    {
      label: "View billing",
      href: `${base}/billing`,
      show: opens(`${base}/billing`),
    },
    {
      label: "Organization settings",
      href: `${base}/settings`,
      show: can("settings.manage"),
    },
  ].filter((a) => a.show);

  let figures: React.ReactNode;
  if (analytics.isPending) {
    figures = (
      <StatRow columns={4}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  } else if (analytics.isError) {
    figures = (
      <ErrorState
        title="Couldn't load this organization's figures"
        onRetry={() => void analytics.refetch()}
      />
    );
  } else {
    figures = (
      <StatRow columns={4}>
        <Stat
          label="Members"
          value={analytics.data.members.total}
          hint={`${analytics.data.members.active} active`}
          href={opens(`${base}/members`) ? `${base}/members` : undefined}
        />
        {canSponsor && (
          <Stat
            label="Active programs"
            value={analytics.data.programs.active}
            hint={`${analytics.data.programs.activeAssignments} active assignments`}
            href={opens(`${base}/programs`) ? `${base}/programs` : undefined}
          />
        )}
        {/* MANAGER reads money but never moves it — figures only. */}
        {can("billing.read") && analytics.data.wallet && (
          <Stat
            label="Wallet balance"
            value={formatCurrencyAmount(
              analytics.data.wallet.balancePaise,
              currency,
            )}
            href={`${base}/billing?tab=wallet`}
          />
        )}
        {can("billing.read") && analytics.data.invoices && (
          <Stat
            label="Outstanding invoices"
            value={formatCurrencyAmount(
              analytics.data.invoices.outstandingPaise,
              currency,
            )}
            hint={`${analytics.data.invoices.outstandingCount} unpaid`}
            tone={
              analytics.data.invoices.pastDueCount > 0 ? "critical" : "neutral"
            }
            href={`${base}/billing`}
          />
        )}
      </StatRow>
    );
  }

  let activityBody: React.ReactNode;
  if (activity.isPending) {
    activityBody = <p className="text-sm text-muted-foreground">Loading…</p>;
  } else if (activity.isError) {
    activityBody = (
      <ErrorState
        title="Couldn't load recent activity"
        onRetry={() => void activity.refetch()}
      />
    );
  } else if (activity.data.activity.length === 0) {
    activityBody = (
      <EmptyState
        title="No activity yet"
        description="Invitations, programs and billing events appear here."
      />
    );
  } else {
    activityBody = (
      <ul className="divide-y divide-border text-sm">
        {activity.data.activity.map((item, i) => (
          <li
            key={`${item.category}-${item.createdAt}-${i}`}
            className="flex items-center justify-between gap-3 py-2"
          >
            <span className="min-w-0 truncate">{item.description}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {timeAgo(item.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <ActionRequiredPanel items={actionItems} heading="Action required" />
      {showChecklist && <Checklist steps={checklist} />}
      {figures}
      {quickActions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {quickActions.map((action) => (
            <Button key={action.label} asChild variant="outline" size="sm">
              <Link href={action.href}>{action.label}</Link>
            </Button>
          ))}
        </div>
      )}
      <Section title="Recent activity">{activityBody}</Section>
    </>
  );
}
