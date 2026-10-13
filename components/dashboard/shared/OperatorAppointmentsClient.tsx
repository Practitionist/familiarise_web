"use client";

import { useState, useEffect, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Stat, StatRow } from "@/components/dashboard/Stat";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { AwaitingPaymentPanel } from "./AwaitingPaymentPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Video,
  Monitor,
  BookOpen,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useListParams } from "@/hooks/useListParams";
import { AppointmentTimeline } from "./AppointmentTimeline";
import { useZonedFormat } from "@/lib/time/zoned-format";
import type {
  StaffAppointment,
  StaffAppointmentsPayload,
} from "@/lib/data/staff-appointments";

type Appointment = StaffAppointment;

const getTypeIcon = (type: string) => {
  switch (type.toLowerCase()) {
    case "consultation":
      return Video;
    case "subscription":
      return Clock;
    case "webinar":
      return Monitor;
    case "class":
      return BookOpen;
    default:
      return Calendar;
  }
};

/** #1527 — display status → tone (the derived tabs: scheduled/completed/issue). */
const STATUS_TONE: Record<string, Tone> = {
  scheduled: "info",
  in_progress: "info",
  completed: "success",
  cancelled: "neutral",
};

const TABS = [
  "all",
  "issue",
  "awaiting-payment",
  "scheduled",
  "completed",
] as const;

// #1527 QA — date-fns patterns in the page's display zone (DisplayZoneProvider
// in OperatorAppointmentsPage), not toLocaleString in the runtime zone.
const DATE_PATTERN = "d MMM, hh:mm a";
const FULL_DATE_PATTERN = "EEE, d MMM yyyy, hh:mm a";

const formatCurrency = (amount: number, currency: string = "INR") => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency,
    maximumFractionDigits: 0,
  }).format(amount / 100);
};

// #890 — defaults MUST match the server prefetch's queryKey in page.tsx so the
// initial (unfiltered, page 1) view hydrates from the dehydrated cache without
// a fetch waterfall. Filtered/paged views fall back to a client fetch.
const DEFAULT_TYPE = "all";
const DEFAULT_TAB = "all";
const TYPE_FILTERS = new Set([
  "consultation",
  "subscription",
  "webinar",
  "class",
]);

// #890 — queryKey is structural: [scope, { page, type, status, search }].
// The page.tsx prefetch uses the identical default object below.
function appointmentsKey(args: {
  page: number;
  type: string;
  status: string;
  search: string;
}) {
  return ["staff-appointments", args] as const;
}

export function OperatorAppointmentsClient({
  beforeContent,
  renderOps,
}: Readonly<{
  beforeContent?: ReactNode;
  renderOps?: (appointmentId: string) => ReactNode;
}>) {
  const { toast } = useToast();
  const zoned = useZonedFormat();
  // #1527 QA D2 — page, type, tab and search live in the URL, so reload and
  // Back keep a triager's place. `?type=class` is the retired class-series
  // URL (#1771); `?tab=awaiting-payment` the retired approval-payments one (Q9).
  const list = useListParams({ filterKeys: ["tab", "type", "open"] });
  const { page, setParams } = list;
  // #1527 — a support case's booking card lands here as `?open=<id>`: search
  // for it on All, then open it. Consumed into `q` below.
  const linkedOpen = list.filters.open;
  const debouncedSearch = linkedOpen ?? list.q;
  const urlTab = list.filters.tab ?? DEFAULT_TAB;
  const activeTab =
    !linkedOpen && (TABS as readonly string[]).includes(urlTab)
      ? urlTab
      : DEFAULT_TAB;
  const urlType = list.filters.type ?? DEFAULT_TYPE;
  const typeFilter = TYPE_FILTERS.has(urlType) ? urlType : DEFAULT_TYPE;
  const setActiveTab = (next: string) =>
    list.setFilter("tab", next === DEFAULT_TAB ? null : next);
  const setTypeFilter = (next: string) =>
    list.setFilter("type", next === DEFAULT_TYPE ? null : next);

  // An Awaiting-payment row opens its booking: search by id, then open it.
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(linkedOpen);
  useEffect(() => {
    if (linkedOpen) {
      setParams({ q: linkedOpen, filters: { tab: null, open: null } });
    }
  }, [linkedOpen, setParams]);
  const [selectedAppointment, setSelectedAppointment] =
    useState<Appointment | null>(null);

  // The input keeps its own draft; the URL gets it after a pause. An outside
  // change (openBooking, Back) replaces the draft, but the echo of our own
  // write does not, or it would eat keys typed since (same as FilterBar).
  const [searchQuery, setSearchQuery] = useState(debouncedSearch);
  const [seenSearch, setSeenSearch] = useState(debouncedSearch);
  const [emittedSearch, setEmittedSearch] = useState<string | null>(null);
  if (debouncedSearch !== seenSearch) {
    setSeenSearch(debouncedSearch);
    if (debouncedSearch !== emittedSearch) setSearchQuery(debouncedSearch);
  }
  useEffect(() => {
    if (searchQuery.trim() === debouncedSearch) return;
    const timer = setTimeout(() => {
      setEmittedSearch(searchQuery.trim());
      setParams({ q: searchQuery });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, debouncedSearch, setParams]);

  const { data, isLoading, isFetching, refetch, error } =
    useQuery<StaffAppointmentsPayload>({
      queryKey: appointmentsKey({
        page,
        type: typeFilter,
        status: activeTab,
        search: debouncedSearch,
      }),
      // Tab, type, page and search all live in the key, so each combination is
      // its own query. Same fix as #346 on the appointments list.
      placeholderData: keepPreviousData,
      queryFn: async () => {
        const params = new URLSearchParams();
        params.set("page", page.toString());
        if (typeFilter !== "all") params.set("type", typeFilter.toUpperCase());
        if (activeTab !== "all") params.set("status", activeTab);
        if (debouncedSearch) params.set("search", debouncedSearch);

        const response = await fetch(`/api/staff/appointments?${params}`);
        if (!response.ok) throw new Error("Failed to fetch appointments");
        return response.json();
      },
      refetchOnWindowFocus: false,
      // The Awaiting payment tab reads its own source (approval payments).
      enabled: activeTab !== "awaiting-payment",
    });

  useEffect(() => {
    if (error) {
      console.error("Error fetching appointments:", error);
      toast({
        title: "Error",
        description: "Failed to load appointments",
        variant: "destructive",
      });
    }
  }, [error, toast]);

  // `isFetching` still drives the refresh button's spinner — that is what it is
  // for. It must NOT drive the panel body: with keepPreviousData the rows are
  // on screen and correct-but-stale, and replacing them with a spinner on every
  // background refetch is the flash this change removes.
  const refreshing = isLoading || isFetching;
  const showLoadingPanel = isLoading && !data;
  const appointments = data?.appointments ?? [];
  const counts = data?.counts ?? {
    all: 0,
    issues: 0,
    scheduled: 0,
    completed: 0,
  };
  const totalPages = data?.pagination.totalPages ?? 1;

  // Sonar S3358 — an if/else chain instead of a nested ternary for which
  // tab panel renders.
  let tabPanelKind: "awaiting-payment" | "loading" | "empty" | "list";
  if (activeTab === "awaiting-payment") tabPanelKind = "awaiting-payment";
  else if (showLoadingPanel) tabPanelKind = "loading";
  else if (appointments.length === 0) tabPanelKind = "empty";
  else tabPanelKind = "list";

  const openBooking = (appointmentId: string) => {
    setParams({ q: appointmentId, filters: { tab: null, type: null } });
    setPendingOpenId(appointmentId);
  };
  const toOpen = pendingOpenId
    ? appointments.find((a) => a.id === pendingOpenId)
    : undefined;
  if (toOpen) {
    setPendingOpenId(null);
    setSelectedAppointment(toOpen);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Appointments"
        description="Every booking on the platform, with its money and ops actions."
        actions={
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={refreshing}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {beforeContent}

      {/* Global counts within the filters (#897), not the current page. */}
      <StatRow>
        <Stat label="Appointments" value={counts.all} icon={Calendar} />
        <Stat
          label="Issues"
          value={counts.issues}
          icon={AlertTriangle}
          tone={counts.issues > 0 ? "warning" : "neutral"}
        />
        <Stat label="Scheduled" value={counts.scheduled} icon={Clock} />
        <Stat label="Completed" value={counts.completed} icon={CheckCircle2} />
      </StatRow>

      {/* Tabs and Filters */}
      <div className="space-y-4">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex flex-col sm:flex-row gap-4 justify-between">
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="issue" className="gap-1">
                Issues
                {counts.issues > 0 && (
                  <Badge variant="destructive" className="ml-1 h-5 px-1.5">
                    {counts.issues}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="awaiting-payment">
                Awaiting payment
              </TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              <TabsTrigger value="completed">Completed</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Search appointments"
                  placeholder="Search..."
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full max-w-[10rem] sm:w-40">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="consultation">Consultation</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="webinar">Webinar</SelectItem>
                  <SelectItem value="class">Class</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* All Tabs Content */}
          <TabsContent value={activeTab} className="mt-4">
            {tabPanelKind === "awaiting-payment" && (
              <AwaitingPaymentPanel onOpenBooking={openBooking} />
            )}
            {tabPanelKind === "loading" && (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            )}
            {tabPanelKind === "empty" && (
              <Card>
                <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <Calendar className="h-12 w-12 mb-4 text-muted-foreground/40" />
                  <p>No appointments found</p>
                </CardContent>
              </Card>
            )}
            {tabPanelKind === "list" && (
              <div className="space-y-3">
                {appointments.map((appointment) => {
                  const TypeIcon = getTypeIcon(appointment.type);
                  return (
                    <Card
                      key={appointment.id}
                      className="cursor-pointer transition-shadow hover:shadow-md"
                      onClick={() => setSelectedAppointment(appointment)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <div className="rounded-lg bg-muted p-2">
                              <TypeIcon className="h-4 w-4" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-medium">
                                  {appointment.title}
                                </p>
                                <Badge variant="outline">
                                  {humanizeEnum(appointment.type)}
                                </Badge>
                                <StatusBadge
                                  label={humanizeEnum(appointment.status)}
                                  tone={
                                    STATUS_TONE[appointment.status] ?? "neutral"
                                  }
                                />
                                {appointment.hasIssue && (
                                  <StatusBadge
                                    label={appointment.issueType ?? "Issue"}
                                    tone="warning"
                                  />
                                )}
                                {/* #1486 — a reschedule waiting on a party.
                                    One label, not two: the query filters to the
                                    open statuses, and since the counter-round was
                                    retired the only open status is PENDING_REVIEW. */}
                                {appointment.reschedule && (
                                  <StatusBadge
                                    label="Reschedule proposed"
                                    tone="caution"
                                  />
                                )}
                              </div>
                              <div className="flex items-center gap-4 mt-2">
                                {appointment.consultant && (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <Avatar className="h-5 w-5">
                                      <AvatarImage
                                        src={
                                          appointment.consultant.avatar || ""
                                        }
                                      />
                                      <AvatarFallback className="text-xs">
                                        {(
                                          appointment.consultant.name ||
                                          appointment.consultant.email ||
                                          "C"
                                        )
                                          .charAt(0)
                                          .toUpperCase()}
                                      </AvatarFallback>
                                    </Avatar>
                                    <span>
                                      {appointment.consultant.name || "Unknown"}
                                    </span>
                                  </div>
                                )}
                                {appointment.consultee && (
                                  <>
                                    <span className="text-muted-foreground/70">
                                      →
                                    </span>
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                      <Avatar className="h-5 w-5">
                                        <AvatarImage
                                          src={
                                            appointment.consultee.avatar || ""
                                          }
                                        />
                                        <AvatarFallback className="text-xs">
                                          {(
                                            appointment.consultee.name ||
                                            appointment.consultee.email ||
                                            "U"
                                          )
                                            .charAt(0)
                                            .toUpperCase()}
                                        </AvatarFallback>
                                      </Avatar>
                                      <span>
                                        {appointment.consultee.name ||
                                          "Unknown"}
                                      </span>
                                    </div>
                                  </>
                                )}
                              </div>
                              <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground/70">
                                <span className="flex items-center gap-1">
                                  <Calendar className="h-3 w-3" />
                                  {zoned(appointment.scheduledAt, DATE_PATTERN)}
                                </span>
                                {appointment.duration > 0 && (
                                  <span className="flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    {appointment.duration} min
                                  </span>
                                )}
                                {appointment.payment && (
                                  <span>
                                    {formatCurrency(
                                      appointment.payment.amount,
                                      appointment.payment.currency,
                                    )}{" "}
                                    • {appointment.payment.status.toLowerCase()}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Pagination — #1527 review — hidden on Awaiting payment, which owns
            its own list; without this, placeholderData could carry a
            previous tab's totalPages onto a tab that renders no pager. */}
        {activeTab !== "awaiting-payment" && totalPages > 1 && (
          <div className="flex justify-center gap-2 mt-4">
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => list.setPage(page - 1)}
            >
              Previous
            </Button>
            <span className="flex items-center px-4 text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => list.setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      {/* Appointment Detail Dialog */}
      <ResponsiveModal
        open={!!selectedAppointment}
        onOpenChange={() => setSelectedAppointment(null)}
      >
        <ResponsiveModalContent className="max-w-2xl">
          {selectedAppointment && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle className="flex items-center gap-2">
                  {(() => {
                    const TypeIcon = getTypeIcon(selectedAppointment.type);
                    return <TypeIcon className="h-5 w-5" />;
                  })()}
                  {selectedAppointment.title}
                </ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  {selectedAppointment.id.slice(-8).toUpperCase()} •{" "}
                  {selectedAppointment.type}
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>
              <div className="space-y-4">
                {/* Status */}
                <div className="flex items-center gap-2">
                  <StatusBadge
                    label={humanizeEnum(selectedAppointment.status)}
                    tone={STATUS_TONE[selectedAppointment.status] ?? "neutral"}
                  />
                  <Badge variant="outline">
                    {humanizeEnum(selectedAppointment.type)}
                  </Badge>
                  {selectedAppointment.hasIssue && (
                    <StatusBadge
                      label={selectedAppointment.issueType ?? "Issue"}
                      tone="warning"
                    />
                  )}
                </div>

                {/* Participants */}
                <div className="grid gap-4 sm:grid-cols-2">
                  {selectedAppointment.consultant && (
                    <div className="p-3 rounded-lg bg-muted">
                      <Label className="text-xs text-muted-foreground">
                        Expert
                      </Label>
                      <div className="flex items-center gap-2 mt-2">
                        <Avatar>
                          <AvatarImage
                            src={selectedAppointment.consultant.avatar || ""}
                          />
                          <AvatarFallback>
                            {(
                              selectedAppointment.consultant.name ||
                              selectedAppointment.consultant.email ||
                              "C"
                            )
                              .charAt(0)
                              .toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">
                            {selectedAppointment.consultant.name || "Unknown"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {selectedAppointment.consultant.email}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  {selectedAppointment.consultee && (
                    <div className="p-3 rounded-lg bg-muted">
                      <Label className="text-xs text-muted-foreground">
                        Learner
                      </Label>
                      <div className="flex items-center gap-2 mt-2">
                        <Avatar>
                          <AvatarImage
                            src={selectedAppointment.consultee.avatar || ""}
                          />
                          <AvatarFallback>
                            {(
                              selectedAppointment.consultee.name ||
                              selectedAppointment.consultee.email ||
                              "U"
                            )
                              .charAt(0)
                              .toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">
                            {selectedAppointment.consultee.name || "Unknown"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {selectedAppointment.consultee.email}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Schedule */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Scheduled At
                    </Label>
                    <p>
                      {zoned(
                        selectedAppointment.scheduledAt,
                        FULL_DATE_PATTERN,
                      )}
                    </p>
                  </div>
                  {selectedAppointment.duration > 0 && (
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Duration
                      </Label>
                      <p>{selectedAppointment.duration} minutes</p>
                    </div>
                  )}
                </div>

                {/* Payment */}
                {selectedAppointment.payment && (
                  <div className="p-3 rounded-lg bg-muted">
                    <Label className="text-xs text-muted-foreground">
                      Payment Details
                    </Label>
                    <div className="grid gap-3 sm:grid-cols-3 mt-2">
                      <div>
                        <p className="text-lg font-bold">
                          {formatCurrency(
                            selectedAppointment.payment.amount,
                            selectedAppointment.payment.currency,
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Status</p>
                        <p className="capitalize">
                          {selectedAppointment.payment.status.toLowerCase()}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Gateway</p>
                        <p>{selectedAppointment.payment.gateway}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Audit trail (#1319 PR 8 / #448) — mounted with the modal, so
                    the trail is fetched only for the row an operator opened. */}
                <AppointmentTimeline appointmentId={selectedAppointment.id} />

                {renderOps?.(selectedAppointment.id)}
              </div>
              <ResponsiveModalFooter>
                <Button
                  variant="outline"
                  onClick={() => setSelectedAppointment(null)}
                >
                  Close
                </Button>
              </ResponsiveModalFooter>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
