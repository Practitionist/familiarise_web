"use client";

import { use, useEffect, useState } from "react";
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
  X,
  Clock,
} from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { Button } from "@/components/ui/button";
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

export default function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
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

  const isLoading = analytics.isLoading || billing.isLoading;

  // Onboarding checklist (localStorage-persisted dismissal)
  const [dismissed, setDismissed] = useState(true); // default true to avoid flash
  useEffect(() => {
    if (typeof window !== "undefined") {
      setDismissed(
        localStorage.getItem(`orgOnboardingDismissed_${orgId}`) === "true",
      );
    }
  }, [orgId]);

  const dismiss = () => {
    localStorage.setItem(`orgOnboardingDismissed_${orgId}`, "true");
    setDismissed(true);
  };

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
  const showChecklist =
    !dismissed &&
    !isLoading &&
    isAtLeast("ORG_ADMIN") &&
    checklistDone < checklist.length;

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
        {/* Stat cards */}
        {isLoading ? (
          <DashboardGrid columns={4}>
            {[1, 2, 3, 4].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : (
          <DashboardGrid columns={4}>
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
          </DashboardGrid>
        )}

        {/* Billing-mode-specific secondary cards */}
        {!isLoading && billing.data && isAtLeast("ORG_MANAGER") && (
          <div className="mt-4">
            <DashboardGrid columns={3}>
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
                    subtitle={`${billing.data.pendingCharges.paymentCount} bookings not yet invoiced`}
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
            </DashboardGrid>
          </div>
        )}

        {/* Onboarding checklist */}
        {showChecklist && (
          <Card className="mt-6">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <div className="flex items-center gap-2">
                <Rocket className="h-5 w-5 text-zinc-600" />
                <CardTitle className="text-base">Get started</CardTitle>
              </div>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                <X className="h-4 w-4" />
              </Button>
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
                        : "text-zinc-700 hover:bg-zinc-50"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        item.done
                          ? "border-emerald-500 bg-emerald-500"
                          : "border-zinc-300"
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
