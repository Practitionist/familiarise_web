"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  RefreshCw,
  Loader2,
  CheckCircle,
  Clock,
  XCircle,
  AlertTriangle,
  Users,
  ExternalLink,
  Calendar,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PagedListFilterCard, statusSelect } from "./paged-list-filters";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { BookingOpsPanel } from "@/components/dashboard/backoffice/money/BookingOpsPanel";
import { DoorDialog } from "@/components/dashboard/backoffice/money/DoorDialog";
import { PlatformCancelDoor } from "@/components/dashboard/backoffice/money/PlatformCancelDoor";
import { formatCurrencyAmount } from "@/utils/formatting";
import { subscriptionStatusLabel } from "@/lib/labels/money-labels";
import type {
  SubscriptionListItem,
  SubscriptionListResponse,
} from "@/types/subscriptions";

export interface EnrichedSubscriptionItem extends SubscriptionListItem {
  appointmentId?: string | null;
  subscriptionId?: string | null;
  userId?: string;
  consultantUserId?: string | null;
  consultantEmail?: string | null;
  planTitle?: string;
  durationInMonths?: number;
  sessionsPerWeek?: number;
  sessionsTotal?: number;
  sessionsCompleted?: number;
  sessionsUpcoming?: number;
  sessionsScheduled?: number;
}

const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "active":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "expiring_soon":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "expired":
    case "cancelled":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toLowerCase()) {
    case "active":
      return <CheckCircle className="h-3 w-3" />;
    case "expiring_soon":
      return <AlertTriangle className="h-3 w-3" />;
    case "expired":
    case "cancelled":
      return <XCircle className="h-3 w-3" />;
    default:
      return <Clock className="h-3 w-3" />;
  }
};

const formatCurrency = (amount: number, currency: string = "INR") =>
  formatCurrencyAmount(amount, currency);

const formatDate = (dateString: string | null) => {
  if (!dateString) return "-";
  return new Date(dateString).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const EMPTY_STATS = { activeCount: 0, expiringCount: 0, expiredCount: 0 };
const CANCEL_INVALIDATE = [["admin-subscriptions"], ["booking-ops"]];
const LIMIT = 20;

function UserLinkRow({
  label,
  userId,
  name,
  fallback,
  basePath,
}: Readonly<{
  label: string;
  userId?: string | null;
  name?: string | null;
  fallback: string;
  basePath: string;
}>) {
  const display = name || fallback;
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-muted-foreground">{label}</span>
      {userId ? (
        <Link
          href={`${basePath}/users/${userId}`}
          className="flex items-center gap-1 font-medium hover:underline"
        >
          {display}
          <ExternalLink className="h-3 w-3" />
        </Link>
      ) : (
        <span className="font-medium">{display}</span>
      )}
    </div>
  );
}

function SubscriptionDetailSheet({
  subscription,
  open,
  onOpenChange,
  basePath,
  canMutate,
}: Readonly<{
  subscription: EnrichedSubscriptionItem | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  basePath: string;
  canMutate: boolean;
}>) {
  const [cancelOpen, setCancelOpen] = useState(false);

  if (!subscription) return null;

  const totalQuota = subscription.sessionsTotal ?? 0;
  const completed = subscription.sessionsCompleted ?? 0;
  const scheduled = subscription.sessionsScheduled ?? 0;
  const upcoming =
    subscription.sessionsUpcoming ?? Math.max(0, scheduled - completed);
  const progressPct =
    totalQuota > 0
      ? Math.min(100, Math.round((completed / totalQuota) * 100))
      : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto space-y-6">
        <SheetHeader>
          <SheetTitle>
            {subscription.planTitle || "Subscription Details"}
          </SheetTitle>
          <SheetDescription>
            Inspect plan entitlement, session quota progress, cycle dates, and
            operator actions.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 text-sm">
          <div className="divide-y rounded-lg border px-3">
            <div className="flex items-center justify-between py-2.5">
              <span className="text-muted-foreground">Status</span>
              <Badge
                className={`${getStatusColor(subscription.status)} gap-1`}
                variant="secondary"
              >
                {getStatusIcon(subscription.status)}
                {subscriptionStatusLabel(subscription.status)}
              </Badge>
            </div>

            <UserLinkRow
              label="Consultee"
              userId={subscription.userId}
              name={subscription.userName}
              fallback="—"
              basePath={basePath}
            />

            <UserLinkRow
              label="Consultant"
              userId={subscription.consultantUserId}
              name={subscription.consultantName}
              fallback={subscription.consultantUserId ? "Expert" : "—"}
              basePath={basePath}
            />

            <div className="flex items-center justify-between py-2.5">
              <span className="text-muted-foreground">Amount Paid</span>
              <span className="font-semibold tabular-nums">
                {formatCurrency(subscription.amount, subscription.currency)} (
                {subscription.gateway})
              </span>
            </div>

            <div className="flex items-center justify-between py-2.5">
              <span className="text-muted-foreground">Cycle Dates</span>
              <span className="flex items-center gap-1 text-xs">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                {formatDate(subscription.startDate)} →{" "}
                {formatDate(subscription.endDate)}
              </span>
            </div>

            {subscription.durationInMonths && (
              <div className="flex items-center justify-between py-2.5">
                <span className="text-muted-foreground">Cadence</span>
                <span>
                  {subscription.sessionsPerWeek ?? 1}/week ·{" "}
                  {subscription.durationInMonths} month(s)
                </span>
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs font-medium">
              <span>Session Quota Progress</span>
              <span className="tabular-nums">
                {completed} completed · {upcoming} upcoming / {totalQuota} total
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-emerald-600 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {canMutate &&
            subscription.subscriptionId &&
            subscription.status !== "cancelled" && (
              <div className="rounded-lg border bg-muted/20 p-3.5 space-y-3">
                <h4 className="text-sm font-semibold">
                  Cancel Subscription (Audited)
                </h4>
                <div className="flex items-center justify-between gap-2">
                  <Button size="sm" variant="outline" asChild>
                    <Link
                      href={`${basePath}/bookings?search=${encodeURIComponent(subscription.id)}`}
                    >
                      Open in Bookings Ops
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setCancelOpen(true)}
                  >
                    Cancel Subscription
                  </Button>
                </div>
              </div>
            )}

          {subscription.appointmentId && (
            <div className="rounded-lg border p-3.5">
              <BookingOpsPanel appointmentId={subscription.appointmentId} />
            </div>
          )}
        </div>
        {/* A booked subscription cancels through the platform cancel door,
            which refunds it; one with no booking is only marked cancelled. */}
        {subscription.appointmentId ? (
          <PlatformCancelDoor
            appointmentId={subscription.appointmentId}
            open={cancelOpen}
            invalidate={CANCEL_INVALIDATE}
            onClose={() => setCancelOpen(false)}
          />
        ) : (
          <DoorDialog
            door={
              cancelOpen && subscription.subscriptionId
                ? {
                    url: "/api/admin/subscriptions",
                    title: "Cancel this subscription",
                    description:
                      "It has no booking yet, so it is only marked cancelled and nothing is refunded.",
                    confirm: "Cancel subscription",
                    body: {
                      subscriptionId: subscription.subscriptionId,
                      action: "CANCEL",
                    },
                  }
                : null
            }
            invalidate={CANCEL_INVALIDATE}
            onClose={() => setCancelOpen(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

const SUBSCRIPTION_COLUMNS: ResponsiveColumn<EnrichedSubscriptionItem>[] = [
  {
    key: "user",
    header: "Consultee",
    primary: true,
    cell: (subscription) => (
      <div>
        <p className="font-medium">{subscription.userName}</p>
        <p className="text-xs text-muted-foreground/70">
          {subscription.userEmail}
        </p>
      </div>
    ),
  },
  {
    key: "consultant",
    header: "Expert / Plan",
    className: "text-sm text-muted-foreground",
    cell: (subscription) => (
      <div>
        <p className="font-medium text-foreground">
          {subscription.consultantName || "-"}
        </p>
        {subscription.planTitle && (
          <p className="text-xs text-muted-foreground">
            {subscription.planTitle}
          </p>
        )}
      </div>
    ),
  },
  {
    key: "quota",
    header: "Sessions",
    cell: (subscription) => (
      <span className="text-sm tabular-nums">
        {subscription.sessionsCompleted ?? 0} /{" "}
        {subscription.sessionsTotal ?? "—"}
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    className: "font-medium",
    cell: (subscription) =>
      formatCurrency(subscription.amount, subscription.currency),
  },
  {
    key: "period",
    header: "Period",
    cell: (subscription) => (
      <div className="text-sm">
        <p>{formatDate(subscription.startDate)}</p>
        <p className="text-muted-foreground/70">
          to {formatDate(subscription.endDate)}
        </p>
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (subscription) => (
      <Badge
        className={`${getStatusColor(subscription.status)} gap-1`}
        variant="secondary"
      >
        {getStatusIcon(subscription.status)}
        {subscriptionStatusLabel(subscription.status)}
      </Badge>
    ),
  },
];

export interface SubscriptionsPageProps {
  apiEndpoint?: string;
  title?: string;
  description?: string;
}

export function SubscriptionsPage({
  apiEndpoint = "/api/admin/subscriptions",
  title = "Subscriptions",
  description = "Inspect platform subscriptions, session quota progress, and booking operations",
}: SubscriptionsPageProps) {
  const { basePath, can } = useBackofficeCapability();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedSubscription, setSelectedSubscription] =
    useState<EnrichedSubscriptionItem | null>(null);

  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: [
      "admin-subscriptions",
      apiEndpoint,
      page,
      searchQuery,
      statusFilter,
    ],
    queryFn: async (): Promise<
      Omit<SubscriptionListResponse, "subscriptions"> & {
        subscriptions: EnrichedSubscriptionItem[];
      }
    > => {
      const params = new URLSearchParams();
      params.set("limit", LIMIT.toString());
      params.set("offset", ((page - 1) * LIMIT).toString());
      if (searchQuery) params.set("search", searchQuery);
      if (statusFilter !== "all") params.set("status", statusFilter);

      const response = await fetch(`${apiEndpoint}?${params}`);
      if (!response.ok) throw new Error("Failed to fetch subscriptions");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });

  const subscriptions = data?.subscriptions ?? [];
  const stats = data?.stats ?? EMPTY_STATS;
  const total = data?.pagination.total ?? 0;
  const hasMore = data?.pagination.hasMore ?? false;
  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="space-y-6">
      <DashboardHeader
        title={title}
        subtitle={description}
        actions={
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.activeCount}</p>
              <p className="text-sm text-muted-foreground">Active</p>
            </div>
          </CardContent>
        </Card>
        <Card
          className={
            stats.expiringCount > 0
              ? "border-yellow-200 bg-yellow-50 dark:bg-yellow-950/20"
              : ""
          }
        >
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-yellow-100 dark:bg-yellow-900">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-yellow-600">
                {stats.expiringCount}
              </p>
              <p className="text-sm text-muted-foreground">Expiring Soon</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.expiredCount}</p>
              <p className="text-sm text-muted-foreground">Expired</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Users className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{total}</p>
              <p className="text-sm text-muted-foreground">
                Total Subscriptions
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <PagedListFilterCard
        search={{
          label: "Search subscriptions",
          placeholder: "Search by user name or email...",
          value: searchQuery,
          onChange: setSearchQuery,
        }}
        selects={[
          statusSelect(statusFilter, setStatusFilter, [
            { value: "active", label: "Active" },
            { value: "expiring_soon", label: "Expiring Soon" },
            { value: "expired", label: "Expired" },
            { value: "cancelled", label: "Cancelled" },
          ]),
        ]}
        setPage={setPage}
      />

      <Card>
        <CardContent className="p-0 sm:p-6">
          {isError && !data && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load subscriptions.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetch()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          )}
          {(!isError || Boolean(data)) && isPending && (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
            </div>
          )}
          {(!isError || Boolean(data)) && !isPending && (
            <ResponsiveTable<EnrichedSubscriptionItem>
              columns={SUBSCRIPTION_COLUMNS}
              rows={subscriptions}
              getRowId={(s) => s.id}
              onRowClick={(s) => setSelectedSubscription(s)}
              rowActions={(s) => (
                <div className="flex items-center justify-end gap-1">
                  <Button size="sm" variant="ghost" asChild>
                    <Link
                      href={`${basePath}/bookings?search=${encodeURIComponent(s.id)}`}
                    >
                      Ops
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedSubscription(s)}
                  >
                    Inspect
                  </Button>
                </div>
              )}
              empty={
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <RefreshCw className="h-12 w-12 mb-4 text-muted-foreground/40" />
                  <p>No subscriptions found</p>
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Showing {(page - 1) * LIMIT + 1} to {Math.min(page * LIMIT, total)}{" "}
            of {total}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={!hasMore}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <SubscriptionDetailSheet
        key={selectedSubscription?.id ?? "none"}
        subscription={
          selectedSubscription
            ? (subscriptions.find((s) => s.id === selectedSubscription.id) ??
              selectedSubscription)
            : null
        }
        open={!!selectedSubscription}
        onOpenChange={(v) => !v && setSelectedSubscription(null)}
        basePath={basePath}
        canMutate={can("subscriptions.manage")}
      />
    </div>
  );
}
