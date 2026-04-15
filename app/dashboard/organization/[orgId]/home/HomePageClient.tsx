"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  Users,
  GraduationCap,
  Briefcase,
  CreditCard,
  AlertCircle,
  Mail,
  Settings,
  Check,
  Rocket,
  Clock,
  Wallet,
  UserCog,
} from "lucide-react";

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
// Types
// ---------------------------------------------------------------------------

interface OrgAnalytics {
  members: { total: number; learners: number };
  plans: { active: number };
  bookings: {
    monthToDate: number;
    lastMonth: number;
    deltaPct: number | null;
  };
  revenue: { monthToDateGross: number };
  seatsTotal: number | null;
  seatsUsed: number;
}

interface OrgBilling {
  billingMode: "TAG_ONLY" | "SEAT_PACK" | "INVOICED_MONTHLY";
  outstanding: { amount: number; invoiceCount: number };
  pendingCharges: { amount: number; paymentCount: number } | null;
  creditPool: { balance: number; totalPurchased: number } | null;
}

interface OrgProfileInfo {
  kind: "BUYER" | "PROVIDER" | "HYBRID";
  status: string;
}

interface ProviderStats {
  consultantCount: number;
  earnings: {
    pending: number;
    ready: number;
    paid: number;
  };
}

interface ActivityItem {
  type: "member_joined" | "payment" | "invoice_generated" | "invitation_sent";
  description: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// API fetchers
// ---------------------------------------------------------------------------

async function fetchAnalytics(orgId: string): Promise<OrgAnalytics> {
  const res = await fetch(`/api/organizations/${orgId}/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

async function fetchBilling(orgId: string): Promise<OrgBilling> {
  const res = await fetch(`/api/organizations/${orgId}/billing`);
  if (!res.ok) throw new Error("Failed to load billing");
  return res.json();
}

async function fetchActivity(
  orgId: string,
): Promise<{ activity: ActivityItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/activity?limit=5`);
  if (!res.ok) return { activity: [] };
  return res.json();
}

async function fetchOrgProfile(orgId: string): Promise<OrgProfileInfo> {
  const res = await fetch(`/api/organizations/${orgId}`);
  if (!res.ok) return { kind: "BUYER", status: "ACTIVE" };
  const data = await res.json();
  return { kind: data.profile.kind, status: data.profile.status };
}

async function fetchProviderStats(
  orgId: string,
): Promise<ProviderStats | null> {
  try {
    const [consultantsRes, payoutsRes] = await Promise.all([
      fetch(`/api/organizations/${orgId}/consultants`),
      fetch(`/api/organizations/${orgId}/payouts`),
    ]);
    const consultants = consultantsRes.ok
      ? await consultantsRes.json()
      : { consultants: [] };
    const payouts = payoutsRes.ok
      ? await payoutsRes.json()
      : { payouts: [] };

    // Sum payout amounts by status for a rough earnings view
    const paid = (payouts.payouts ?? [])
      .filter((p: { status: string }) => p.status === "COMPLETED")
      .reduce((s: number, p: { netPayout: number }) => s + p.netPayout, 0);

    return {
      consultantCount: consultants.consultants?.length ?? 0,
      earnings: { pending: 0, ready: 0, paid },
    };
  } catch {
    return null;
  }
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

const ACTIVITY_ICONS: Record<ActivityItem["type"], typeof Users> = {
  member_joined: Users,
  payment: CreditCard,
  invoice_generated: Briefcase,
  invitation_sent: Mail,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HomePageClient({ orgId }: { orgId: string }) {
  const { isAtLeast } = useOrgRole(orgId);

  const analytics = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
  });
  const billing = useQuery({
    queryKey: ["org-billing", orgId],
    queryFn: () => fetchBilling(orgId),
  });
  const activity = useQuery({
    queryKey: ["org-activity", orgId],
    queryFn: () => fetchActivity(orgId),
  });
  const orgProfile = useQuery({
    queryKey: ["org-profile-info", orgId],
    queryFn: () => fetchOrgProfile(orgId),
  });
  const isProviderOrHybrid =
    orgProfile.data?.kind === "PROVIDER" || orgProfile.data?.kind === "HYBRID";
  const providerStats = useQuery({
    queryKey: ["org-provider-stats", orgId],
    queryFn: () => fetchProviderStats(orgId),
    enabled: isProviderOrHybrid,
  });

  const isLoading = analytics.isLoading || billing.isLoading;

  // Onboarding checklist — not dismissable; auto-hides once every item is done.
  // Admins+owners see this so new orgs are guided through the essential setup
  // steps without the risk of accidentally dismissing it before completion.
  const checklist = [
    { label: "Create organization", done: true, href: "#" },
    {
      label: "Invite your first team member",
      done: (analytics.data?.members.total ?? 0) > 1,
      href: `/dashboard/organization/${orgId}/invitations`,
    },
    {
      label: "Create your first plan",
      done: (analytics.data?.plans.active ?? 0) > 0,
      href: `/dashboard/organization/${orgId}/plans`,
    },
    {
      label: "Configure billing settings",
      done: billing.data != null,
      href: `/dashboard/organization/${orgId}/settings`,
    },
  ];
  const checklistDone = checklist.filter((c) => c.done).length;
  const allDone = checklistDone === checklist.length;
  const showChecklist = !isLoading && isAtLeast("ORG_ADMIN") && !allDone;

  // Quick action cards (role-gated)
  const quickActions = [
    {
      title: "Invite member",
      description: "Add team members by email",
      icon: Mail,
      href: `/dashboard/organization/${orgId}/invitations`,
      minRole: "ORG_ADMIN",
    },
    {
      title: "Create plan",
      description: "Set up a new service plan",
      icon: Briefcase,
      href: `/dashboard/organization/${orgId}/plans`,
      minRole: "ORG_ADMIN",
    },
    {
      title: "View billing",
      description: "Invoices and payment summary",
      icon: CreditCard,
      href: `/dashboard/organization/${orgId}/billing`,
      minRole: "ORG_MANAGER",
    },
    {
      title: "Org settings",
      description: "Profile, branding, and configuration",
      icon: Settings,
      href: `/dashboard/organization/${orgId}/settings`,
      minRole: "ORG_ADMIN",
    },
  ].filter((a) => isAtLeast(a.minRole));

  return (
    <>
      <DashboardHeader
        title="Overview"
        subtitle="Snapshot of your organization"
      />
      <DashboardContent>
        {/* Onboarding checklist — hero position, non-dismissable.
            Auto-hides once every step is complete. */}
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
                      {item.done && (
                        <Check className="h-3 w-3 text-white" />
                      )}
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
            visible. On mobile they stack 1-wide, on tablet 2-wide, on
            desktop 4-wide.  Billing and provider cards are injected inline
            once their data arrives — no separate stacked sections that leave
            orphaned cards at different widths. */}
        {isLoading ? (
          <DashboardGrid columns={4}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : (
          <DashboardGrid columns={4}>
            {/* Primary stats — always shown */}
            <StatCard
              title="Active members"
              value={analytics.data?.members.total ?? 0}
              subtitle={`${analytics.data?.members.learners ?? 0} learners`}
              icon={Users}
              variant="info"
            />
            <StatCard
              title="Learners"
              value={analytics.data?.members.learners ?? 0}
              subtitle={
                analytics.data?.seatsTotal
                  ? `${analytics.data.seatsUsed} / ${analytics.data.seatsTotal} seats`
                  : "Unlimited seats"
              }
              icon={GraduationCap}
            />
            <StatCard
              title="Active plans"
              value={analytics.data?.plans.active ?? 0}
              icon={Briefcase}
            />
            <StatCard
              title="This month"
              value={formatCurrencyAmount(
                analytics.data?.revenue.monthToDateGross ?? 0,
                "INR",
              )}
              subtitle={`${analytics.data?.bookings.monthToDate ?? 0} bookings`}
              icon={CreditCard}
              variant="success"
              trend={
                analytics.data?.bookings.deltaPct != null
                  ? {
                      value: Math.round(analytics.data.bookings.deltaPct),
                      isPositive: analytics.data.bookings.deltaPct >= 0,
                    }
                  : undefined
              }
            />

            {/* Billing cards — only for manager+ role, appear once billing data loads */}
            {billing.data && isAtLeast("ORG_MANAGER") && (
              <>
                {billing.data.outstanding.invoiceCount > 0 && (
                  <StatCard
                    title="Outstanding invoices"
                    value={billing.data.outstanding.invoiceCount}
                    subtitle={formatCurrencyAmount(
                      billing.data.outstanding.amount,
                      "INR",
                    )}
                    icon={AlertCircle}
                    variant="warning"
                  />
                )}
                {billing.data.billingMode === "INVOICED_MONTHLY" &&
                  billing.data.pendingCharges && (
                    <StatCard
                      title="Pending charges"
                      value={formatCurrencyAmount(
                        billing.data.pendingCharges.amount,
                        "INR",
                      )}
                      subtitle={`${billing.data.pendingCharges.paymentCount} not yet invoiced`}
                      icon={AlertCircle}
                      variant="warning"
                    />
                  )}
                {billing.data.billingMode === "SEAT_PACK" &&
                  billing.data.creditPool && (
                    <StatCard
                      title="Credit balance"
                      value={formatCurrencyAmount(
                        billing.data.creditPool.balance,
                        "INR",
                      )}
                      subtitle={`${formatCurrencyAmount(
                        billing.data.creditPool.totalPurchased,
                        "INR",
                      )} lifetime`}
                      icon={CreditCard}
                    />
                  )}
              </>
            )}

            {/* Provider/Hybrid stats — appear once provider data loads */}
            {isProviderOrHybrid && providerStats.data && (
              <>
                <StatCard
                  title="Active consultants"
                  value={providerStats.data.consultantCount}
                  icon={UserCog}
                  variant="info"
                />
                <StatCard
                  title="Total payouts"
                  value={formatCurrencyAmount(
                    providerStats.data.earnings.paid,
                    "INR",
                  )}
                  subtitle="Completed payouts"
                  icon={Wallet}
                  variant="success"
                />
              </>
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
                  const Icon = ACTIVITY_ICONS[item.type] ?? Clock;
                  return (
                    <div
                      key={`${item.type}-${i}`}
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
                        {timeAgo(item.timestamp)}
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
