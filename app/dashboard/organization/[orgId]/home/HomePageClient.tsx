"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  Users,
  UserCheck,
  Briefcase,
  CreditCard,
  AlertCircle,
  Mail,
  Settings,
  Check,
  Rocket,
  Clock,
  Wallet,
  FileText,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import type { FundingSource, MemberRole } from "@prisma/client";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useOrgRole } from "../useOrgRole";

// ---------------------------------------------------------------------------
// Types — shaped to match the actual analytics + activity APIs
// ---------------------------------------------------------------------------

interface OrgAnalytics {
  capabilities: {
    canSponsor: boolean;
    canHost: boolean;
    fundingSource: FundingSource | null;
    walletBalance: number | null;
    currency: string | null;
  };
  members: {
    total: number;
    active: number;
    byRole: Array<{ role: MemberRole; count: number }>;
  };
  programs: {
    total: number;
    active: number;
    activeAssignments: number;
  };
  wallet: {
    balancePaise: number;
    recent: Array<{ reason: string; count: number; deltaPaise: number }>;
  } | null;
  invoices: {
    outstandingCount: number;
    outstandingPaise: number;
    pastDueCount: number;
    paidLast30dCount: number;
    paidLast30dPaise: number;
  } | null;
  earnings: Array<{
    status: string;
    count: number;
    orgSharePaise: number;
    refundedPaise: number;
  }> | null;
}

interface ActivityItem {
  category:
    | "MEMBER"
    | "CONTRACT"
    | "PROGRAM"
    | "WALLET"
    | "INVOICE"
    | "PAYOUT"
    | "SETTINGS"
    | "CONSENT"
    | "SYSTEM";
  description: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// API fetchers
// ---------------------------------------------------------------------------

async function fetchAnalytics(orgId: string): Promise<OrgAnalytics> {
  const res = await fetch(`/api/organizations/${orgId}/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

async function fetchActivity(
  orgId: string,
): Promise<{ activity: ActivityItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/activity?limit=5`);
  if (!res.ok) return { activity: [] };
  const json = await res.json();
  return { activity: json.data ?? [] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const ACTIVITY_ICONS: Partial<Record<ActivityItem["category"], LucideIcon>> = {
  MEMBER: Users,
  WALLET: CreditCard,
  INVOICE: Briefcase,
  PAYOUT: Wallet,
  CONTRACT: Briefcase,
  SETTINGS: Settings,
};

function countByRole(
  byRole: OrgAnalytics["members"]["byRole"],
  role: MemberRole,
): number {
  return byRole.find((r) => r.role === role)?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HomePageClient({ orgId }: { orgId: string }) {
  const { isAtLeast } = useOrgRole(orgId);

  const analytics = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
  });
  const activity = useQuery({
    queryKey: ["org-activity", orgId],
    queryFn: () => fetchActivity(orgId),
  });

  const isLoading = analytics.isLoading;
  const data = analytics.data;

  const canSponsor = data?.capabilities.canSponsor ?? false;
  const canHost = data?.capabilities.canHost ?? false;
  const currency = data?.capabilities.currency ?? "INR";
  const learners = data ? countByRole(data.members.byRole, "LEARNER") : 0;
  const experts = data ? countByRole(data.members.byRole, "EXPERT") : 0;

  // Onboarding checklist — auto-hides once every item is done.
  const checklist = [
    { label: "Create organization", done: true, href: "#" },
    {
      label: "Invite your first team member",
      done: (data?.members.total ?? 0) > 1,
      href: `/dashboard/organization/${orgId}/invitations`,
    },
    {
      label: "Create your first Program",
      done: (data?.programs.active ?? 0) > 0,
      href: `/dashboard/organization/${orgId}/programs`,
    },
    {
      label: "Configure billing settings",
      done:
        (data?.wallet !== null && data?.wallet !== undefined) ||
        (data?.invoices !== null && data?.invoices !== undefined),
      href: `/dashboard/organization/${orgId}/billing`,
    },
  ];
  const checklistDone = checklist.filter((c) => c.done).length;
  const allDone = checklistDone === checklist.length;
  const showChecklist = !isLoading && isAtLeast("MAINTAINER") && !allDone;

  // Earnings summary for host orgs — sum of PAID orgShare, net refunds.
  const paidEarnings =
    data?.earnings?.find((e) => e.status === "PAID")?.orgSharePaise ?? 0;

  // Quick action cards (role-gated). `satisfies` keeps every `minRole`
  // compile-time-checked against the real `MemberRole` enum.
  const quickActions = (
    [
      {
        title: "Invite member",
        description: "Add team members by email",
        icon: Mail,
        href: `/dashboard/organization/${orgId}/invitations`,
        minRole: "MAINTAINER",
      },
      {
        title: "Create Program",
        description: "Set up a new licensed-seat or credit-pool program",
        icon: Briefcase,
        href: `/dashboard/organization/${orgId}/programs`,
        minRole: "MAINTAINER",
      },
      {
        title: "View billing",
        description: "Invoices and payment summary",
        icon: CreditCard,
        href: `/dashboard/organization/${orgId}/billing`,
        minRole: "MANAGER",
      },
      {
        title: "Org settings",
        description: "Profile, branding, and configuration",
        icon: Settings,
        href: `/dashboard/organization/${orgId}/settings`,
        minRole: "MAINTAINER",
      },
    ] as const satisfies readonly {
      title: string;
      description: string;
      icon: LucideIcon;
      href: string;
      minRole: MemberRole;
    }[]
  ).filter((a) => isAtLeast(a.minRole));

  return (
    <>
      <DashboardHeader
        title="Overview"
        subtitle="Snapshot of your organization"
      />
      <DashboardContent>
        {/* Onboarding checklist — non-dismissable; auto-hides once every
            step is complete. */}
        {showChecklist && (
          <Card className="mb-6 border-amber-200 bg-amber-50">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Rocket className="h-5 w-5 text-amber-600" />
                <CardTitle className="text-base text-amber-900">
                  Get started — {checklistDone}/{checklist.length} done
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <Progress
                value={(checklistDone / checklist.length) * 100}
                className="mb-4 h-2"
              />
              <div className="space-y-2">
                {checklist.map((item) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={`flex items-center gap-3 rounded-lg p-2 text-sm transition-colors ${
                      item.done
                        ? "text-zinc-400"
                        : "text-amber-800 hover:bg-amber-100"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        item.done
                          ? "border-emerald-500 bg-emerald-500"
                          : "border-amber-400"
                      }`}
                    >
                      {item.done && <Check className="h-3 w-3 text-white" />}
                    </div>
                    <span className={item.done ? "line-through" : ""}>
                      {item.label}
                    </span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Unified stat grid — all cards share one 4-column responsive grid
            so every card has the same width regardless of how many are
            visible. Capability-dependent cards (wallet, invoices, earnings)
            are rendered inline once their section of the analytics payload
            is non-null. */}
        {analytics.isLoading ? (
          <DashboardGrid columns={4}>
            {[1, 2, 3, 4].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : !data ? (
          <DashboardGrid columns={4}>
            <StatCard title="Members" value="—" subtitle="Could not load" icon={Users} variant="info" />
            <StatCard title="Active programs" value="—" subtitle="Could not load" icon={Briefcase} />
            <StatCard title="Experts" value="—" icon={UserCog} />
            <StatCard title="Learners" value="—" icon={UserCheck} />
          </DashboardGrid>
        ) : (
          <DashboardGrid columns={4}>
            <StatCard
              title="Members"
              value={data.members.total}
              subtitle={`${data.members.active} active`}
              icon={Users}
              variant="info"
            />
            {canSponsor && (
              <StatCard
                title="Learners"
                value={learners}
                subtitle={
                  data.programs.activeAssignments > 0
                    ? `${data.programs.activeAssignments} assignments`
                    : "No active assignments"
                }
                icon={UserCheck}
              />
            )}
            {canHost && (
              <StatCard title="Experts" value={experts} icon={UserCog} />
            )}
            <StatCard
              title="Active programs"
              value={data.programs.active}
              subtitle={`${data.programs.total} total`}
              icon={Briefcase}
            />

            {/* Wallet — only shown when BillingAccount.fundingSource=WALLET */}
            {data.wallet && isAtLeast("MANAGER") && (
              <StatCard
                title="Wallet balance"
                value={formatCurrencyAmount(data.wallet.balancePaise, currency)}
                icon={Wallet}
                variant="success"
              />
            )}

            {/* Invoices — only for INVOICE-funded orgs */}
            {data.invoices && isAtLeast("MANAGER") && (
              <>
                {data.invoices.outstandingCount > 0 && (
                  <StatCard
                    title="Outstanding invoices"
                    value={data.invoices.outstandingCount}
                    subtitle={formatCurrencyAmount(
                      data.invoices.outstandingPaise,
                      currency,
                    )}
                    icon={FileText}
                    variant={
                      data.invoices.pastDueCount > 0 ? "warning" : "info"
                    }
                  />
                )}
                {data.invoices.pastDueCount > 0 && (
                  <StatCard
                    title="Past-due invoices"
                    value={data.invoices.pastDueCount}
                    icon={AlertCircle}
                    variant="warning"
                  />
                )}
              </>
            )}

            {/* Host-side earnings summary */}
            {canHost && data.earnings && data.earnings.length > 0 && (
              <StatCard
                title="Paid out"
                value={formatCurrencyAmount(paidEarnings, currency)}
                subtitle="Completed payouts"
                icon={Wallet}
                variant="success"
              />
            )}
          </DashboardGrid>
        )}

        {/* Quick actions */}
        {quickActions.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-zinc-700 mb-3">
              Quick actions
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {quickActions.map((action) => (
                <Link key={action.title} href={action.href}>
                  <Card className="h-full hover:border-zinc-400 transition-colors cursor-pointer">
                    <CardContent className="p-4">
                      <action.icon className="h-5 w-5 text-zinc-500 mb-2" />
                      <p className="text-sm font-medium text-zinc-900">
                        {action.title}
                      </p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {action.description}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Recent activity */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>
              Latest events across your organization
            </CardDescription>
          </CardHeader>
          <CardContent>
            {activity.isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : activity.data && activity.data.activity.length > 0 ? (
              <div className="space-y-3">
                {activity.data.activity.map((item, i) => {
                  const Icon = ACTIVITY_ICONS[item.category] ?? Clock;
                  return (
                    <div
                      key={`${item.category}-${item.createdAt}-${i}`}
                      className="flex items-center gap-3 text-sm"
                    >
                      <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center shrink-0">
                        <Icon className="h-4 w-4 text-zinc-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-zinc-700 truncate">
                          {item.description}
                        </p>
                      </div>
                      <span className="text-xs text-zinc-400 shrink-0">
                        {timeAgo(item.createdAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-zinc-500 text-center py-4">
                No activity yet. Start by inviting your team!
              </p>
            )}
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
