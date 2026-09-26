"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  AlertTriangle,
  Banknote,
  BadgeCheck,
  FileWarning,
  MessagesSquare,
  RotateCcw,
  Scale,
  Shield,
  Ticket,
  type LucideIcon,
} from "lucide-react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { useBackofficeNavCounts } from "@/components/dashboard/backoffice/useBackofficeNavCounts";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { Section } from "@/components/dashboard/Section";
import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import type { BackofficeSurface } from "@/lib/auth/backoffice-permissions";
import type { BackofficeBadgeKey } from "@/lib/dashboard/backoffice-nav";
import { gatewayLabel } from "@/lib/labels/money-labels";
import {
  paymentStatusBadge,
  refundStatusBadge,
} from "@/lib/labels/session-labels";
import { humanizeEnum } from "@/lib/ui/tone";
import type {
  AdminDashboardStats,
  RecentPayment,
  RecentRefund,
} from "@/types/payments";
import { formatCurrencyAmount } from "@/utils/formatting";

// Fetch admin dashboard stats
async function fetchAdminStats(): Promise<AdminDashboardStats> {
  const response = await fetch("/api/admin/stats");
  if (!response.ok) {
    throw new Error("Failed to fetch admin stats");
  }
  return response.json() as Promise<AdminDashboardStats>;
}

/** Q12 — one tile per queue the console can open, each linking to it. */
const QUEUES: Array<{
  key: BackofficeBadgeKey;
  label: string;
  hint: string;
  path: string;
  surface: BackofficeSurface;
  icon: LucideIcon;
}> = [
  {
    key: "tickets",
    label: "Unassigned tickets",
    hint: "Open, nobody on them",
    path: "tickets?view=unassigned",
    surface: "tickets.manage",
    icon: Ticket,
  },
  {
    key: "conversations",
    label: "Conversations",
    hint: "Open or escalated",
    path: "threads",
    surface: "threads.manage",
    icon: MessagesSquare,
  },
  {
    key: "moderation",
    label: "Reports",
    hint: "Waiting for a decision",
    path: "moderation",
    surface: "moderation.manage",
    icon: Shield,
  },
  {
    key: "verification",
    label: "Verifications",
    hint: "Experts and organizations",
    path: "verification",
    surface: "users.verify",
    icon: BadgeCheck,
  },
  {
    key: "refunds",
    label: "Refunds for a human",
    hint: "Seats the sweeps left",
    path: "money/refunds",
    surface: "refunds.manage",
    icon: RotateCcw,
  },
  {
    key: "disputes",
    label: "Open disputes",
    hint: "Response or verdict due",
    path: "money/disputes",
    surface: "disputes.read",
    icon: Scale,
  },
  {
    key: "payouts",
    label: "Payouts to approve",
    hint: "Awaiting approval",
    path: "money/payouts",
    surface: "payouts.read",
    icon: Banknote,
  },
  {
    key: "compliance",
    label: "Compliance",
    hint: "Erasures, breaches, dead emails",
    path: "compliance",
    surface: "compliance.manage",
    icon: FileWarning,
  },
];

function NeedsAttention() {
  const { basePath, can } = useBackofficeCapability();
  const counts = useBackofficeNavCounts();
  const queues = QUEUES.filter((q) => can(q.surface));

  if (counts.isError && !counts.data) {
    return (
      <ErrorState
        title="Queue counts could not be loaded"
        onRetry={() => void counts.refetch()}
      />
    );
  }
  return (
    <StatRow>
      {queues.map((q) =>
        counts.data ? (
          <Stat
            key={q.key}
            label={q.label}
            value={counts.data[q.key] ?? 0}
            hint={q.hint}
            href={`${basePath}/${q.path}`}
            icon={q.icon}
            tone={(counts.data[q.key] ?? 0) > 0 ? "warning" : "neutral"}
          />
        ) : (
          <StatSkeleton key={q.key} />
        ),
      )}
    </StatRow>
  );
}

/**
 * #1527 Q12 — admin's landing: the queues that need a person first, then the
 * platform money snapshot. Staff land on Tickets instead.
 */
export default function AdminHomePageClient() {
  const { basePath } = useBackofficeCapability();
  // queryKey ["admin-stats"] MUST match the getAdminStats prefetch key in
  // home/page.tsx so SSR hydration feeds this useQuery. #890
  const {
    data: stats,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: fetchAdminStats,
    staleTime: 1 * 60 * 1000,
    // Focus rather than a timer: the global default disables focus AND mount
    // refetching, so freshness has to be asked for here.
    refetchOnWindowFocus: true,
  });

  return (
    <>
      <PageHeader
        title="Needs attention"
        description="Every queue waiting on a person, then today's money."
      />
      <DashboardContent>
        <Section title="Queues">
          <NeedsAttention />
        </Section>

        <Section title="Money">
          {/* Surface a real error rather than rendering zeros/"₹0", which
              an admin would read as "no platform activity". */}
          {isError && !stats ? (
            <ErrorState
              title="Money stats could not be loaded"
              onRetry={() => void refetch()}
            />
          ) : (
            <StatRow>
              {isLoading || !stats ? (
                [1, 2, 3, 4].map((i) => <StatSkeleton key={i} />)
              ) : (
                <>
                  <Stat
                    label="Payments"
                    value={stats?.totalPayments || 0}
                    hint={`${formatCurrencyAmount(stats?.totalPaymentsValue ?? 0, "INR")} total value`}
                    href={`${basePath}/money/payments`}
                  />
                  <Stat
                    label="Pending payments"
                    value={stats?.pendingPayments || 0}
                    hint={`${formatCurrencyAmount(stats?.pendingPaymentsValue ?? 0, "INR")} pending`}
                  />
                  <Stat
                    label="Refunds"
                    value={stats?.totalRefunds || 0}
                    hint={`${formatCurrencyAmount(stats?.totalRefundsValue ?? 0, "INR")} refunded`}
                    href={`${basePath}/money/refunds`}
                  />
                  <Stat
                    label="Active disputes"
                    value={stats?.activeDisputes || 0}
                    hint={`${stats?.totalDisputes || 0} in total`}
                    href={`${basePath}/money/disputes`}
                    tone={
                      (stats?.activeDisputes ?? 0) > 0 ? "critical" : "neutral"
                    }
                  />
                </>
              )}
            </StatRow>
          )}
        </Section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Section
            title="Recent payments"
            variant="card"
            actions={
              <Link
                href={`${basePath}/money/payments`}
                className="text-sm font-medium underline-offset-4 hover:underline"
              >
                View all
              </Link>
            }
          >
            <RecentList
              rows={stats?.recentPayments ?? []}
              empty="Payments appear here once they are processed."
              render={(p: RecentPayment) => ({
                key: p.id,
                href: `${basePath}/payments/${p.id}`,
                amount: formatCurrencyAmount(p.amount, p.currency),
                meta: `${gatewayLabel(p.paymentGateway)} · ${
                  p.appointment?.appointmentType
                    ? humanizeEnum(p.appointment.appointmentType)
                    : "No booking"
                }`,
                badge: paymentStatusBadge(p.paymentStatus),
              })}
            />
          </Section>
          <Section
            title="Recent refunds"
            variant="card"
            actions={
              <Link
                href={`${basePath}/money/refunds`}
                className="text-sm font-medium underline-offset-4 hover:underline"
              >
                View all
              </Link>
            }
          >
            <RecentList
              rows={stats?.recentRefunds ?? []}
              empty="Refunds appear here once one is issued."
              // A refund has no page of its own; the list is where it lives
              // (the old per-refund link 404'd).
              render={(r: RecentRefund) => ({
                key: r.id,
                href: `${basePath}/money/refunds`,
                amount: formatCurrencyAmount(r.amountPaise, r.currency),
                meta: gatewayLabel(r.paymentGateway),
                badge: refundStatusBadge(r.status),
              })}
            />
          </Section>
        </div>
      </DashboardContent>
    </>
  );
}

function RecentList<T>({
  rows,
  empty,
  render,
}: Readonly<{
  rows: T[];
  empty: string;
  render: (row: T) => {
    key: string;
    href: string;
    amount: string;
    meta: string;
    badge: { label: string; className: string };
  };
}>) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Nothing yet"
        description={empty}
      />
    );
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => {
        const r = render(row);
        return (
          <li key={r.key}>
            <Link
              href={r.href}
              className="flex items-center justify-between gap-3 py-3 hover:bg-muted/50"
            >
              <div className="min-w-0">
                <p className="font-medium tabular-nums text-foreground">
                  {r.amount}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {r.meta}
                </p>
              </div>
              <StatusBadge {...r.badge} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
