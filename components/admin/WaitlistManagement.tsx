"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { WaitlistStatus } from "@prisma/client";
import { format } from "date-fns";
import {
  Users,
  Clock,
  Bell,
  CheckCircle,
  XCircle,
  SkipForward,
  ChevronDown,
  ChevronRight,
  Calendar,
  LayoutList,
  LayoutGrid,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";

interface WaitlistEntry {
  id: string;
  userId: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
  eventType: "webinar" | "class";
  eventId: string;
  eventTitle: string;
  planId: string;
  consultant: {
    name: string | null;
    image: string | null;
  } | null;
  scheduledDate: string | null;
  isUpcoming: boolean | null;
  status: WaitlistStatus;
  position: number | null;
  priority: number;
  joinedAt: string;
  notifiedAt: string | null;
  expiresAt: string | null;
  respondedAt: string | null;
  bookedAt: string | null;
}

interface WaitlistStats {
  total: number;
  active: number;
  waiting: number;
  notified: number;
  booked: number;
  expired: number;
  cancelled: number;
  skipped: number;
}

async function fetchWaitlists(params: {
  status?: string;
  eventType?: string;
  search?: string;
  groupBy?: string;
  timeline?: string;
  page?: number;
}) {
  const queryParams = new URLSearchParams();
  if (params.status && params.status !== "all") {
    queryParams.set("status", params.status);
  }
  if (params.eventType && params.eventType !== "all") {
    queryParams.set("eventType", params.eventType);
  }
  if (params.search) {
    queryParams.set("search", params.search);
  }
  if (params.groupBy) {
    queryParams.set("groupBy", params.groupBy);
  }
  if (params.timeline && params.timeline !== "all") {
    queryParams.set("timeline", params.timeline);
  }
  if (params.page) {
    queryParams.set("page", params.page.toString());
  }

  const response = await fetch(
    `/api/admin/waitlists?${queryParams.toString()}`,
  );
  if (!response.ok) {
    throw new Error("Failed to fetch waitlists");
  }
  return response.json();
}

const getStatusBadge = (status: WaitlistStatus, compact = false) => {
  const iconClass = compact ? "h-3 w-3" : "h-3 w-3 mr-1";
  switch (status) {
    case "WAITING":
      return (
        <Badge className="bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900">
          <Clock className={iconClass} />
          {!compact && "Waiting"}
        </Badge>
      );
    case "NOTIFIED":
      return (
        <Badge variant="secondary">
          <Bell className={iconClass} />
          {!compact && "Notified"}
        </Badge>
      );
    case "BOOKED":
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900">
          <CheckCircle className={iconClass} />
          {!compact && "Booked"}
        </Badge>
      );
    case "EXPIRED":
      return (
        <Badge className="bg-muted text-muted-foreground border-border">
          <XCircle className={iconClass} />
          {!compact && "Expired"}
        </Badge>
      );
    case "CANCELLED":
      return (
        <Badge className="bg-red-100 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900">
          <XCircle className={iconClass} />
          {!compact && "Cancelled"}
        </Badge>
      );
    case "SKIPPED":
      return (
        <Badge variant="secondary">
          <SkipForward className={iconClass} />
          {!compact && "Skipped"}
        </Badge>
      );
    default:
      return <Badge>{status}</Badge>;
  }
};

// Shared cell renderers so the grouped and list tables stay consistent.
const userCell = (entry: WaitlistEntry) => (
  <div className="flex items-center gap-3">
    <Avatar className="h-8 w-8">
      <AvatarImage
        src={entry.user.image || undefined}
        alt={entry.user.name || "User"}
      />
      <AvatarFallback className="bg-muted text-muted-foreground text-xs">
        {entry.user.name
          ?.split(" ")
          .map((n) => n[0])
          .join("")
          .slice(0, 2) || "??"}
      </AvatarFallback>
    </Avatar>
    <div>
      <p className="font-medium text-sm">{entry.user.name || "No name"}</p>
      <p className="text-xs text-muted-foreground">{entry.user.email}</p>
    </div>
  </div>
);

const positionCell = (entry: WaitlistEntry) =>
  entry.position ? (
    <span className="font-semibold text-foreground">#{entry.position}</span>
  ) : (
    <span className="text-muted-foreground/70">-</span>
  );

const joinedCell = (entry: WaitlistEntry) =>
  format(new Date(entry.joinedAt), "MMM d, yyyy");

const expiresCell = (entry: WaitlistEntry) =>
  entry.expiresAt ? (
    <span
      className={
        new Date(entry.expiresAt) < new Date()
          ? "text-red-600 dark:text-red-400"
          : "text-muted-foreground"
      }
    >
      {format(new Date(entry.expiresAt), "MMM d, h:mm a")}
    </span>
  ) : (
    "-"
  );

const groupedColumns: ResponsiveColumn<WaitlistEntry>[] = [
  { key: "user", header: "User", primary: true, cell: userCell },
  { key: "status", header: "Status", cell: (e) => getStatusBadge(e.status) },
  { key: "position", header: "Position", cell: positionCell },
  {
    key: "joined",
    header: "Joined",
    className: "text-sm text-muted-foreground",
    cell: joinedCell,
  },
  {
    key: "expires",
    header: "Expires",
    className: "text-sm",
    cell: expiresCell,
  },
];

const listColumns: ResponsiveColumn<WaitlistEntry>[] = [
  { key: "user", header: "User", primary: true, cell: userCell },
  {
    key: "event",
    header: "Event",
    cell: (entry) => (
      <Link
        href={`/explore/programs/plans/${entry.eventType === "class" ? "classes" : "webinars"}/${entry.planId}`}
        className="text-foreground underline-offset-4 hover:underline text-sm"
      >
        {entry.eventTitle}
      </Link>
    ),
  },
  {
    key: "type",
    header: "Type",
    cell: (entry) => (
      <Badge variant="outline" className="capitalize text-xs">
        {entry.eventType}
      </Badge>
    ),
  },
  { key: "status", header: "Status", cell: (e) => getStatusBadge(e.status) },
  { key: "position", header: "Position", cell: positionCell },
  {
    key: "scheduled",
    header: "Scheduled",
    className: "text-sm text-muted-foreground",
    cell: (entry) =>
      entry.scheduledDate
        ? format(new Date(entry.scheduledDate), "MMM d, yyyy")
        : "-",
  },
  {
    key: "joined",
    header: "Joined",
    className: "text-sm text-muted-foreground",
    cell: joinedCell,
  },
  {
    key: "expires",
    header: "Expires",
    className: "text-sm",
    cell: expiresCell,
  },
];

function EventGroupCard({
  eventTitle,
  entries,
  defaultOpen = false,
}: {
  eventTitle: string;
  entries: WaitlistEntry[];
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const firstEntry = entries[0];

  // Count statuses in this group
  const waitingCount = entries.filter((e) => e.status === "WAITING").length;
  const notifiedCount = entries.filter((e) => e.status === "NOTIFIED").length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="mb-4">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                {isOpen ? (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                )}
                <div>
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-base">{eventTitle}</CardTitle>
                    <Badge variant="outline" className="capitalize text-xs">
                      {firstEntry?.eventType}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                    {firstEntry?.consultant && (
                      <span className="flex items-center gap-1">
                        <Avatar className="h-4 w-4">
                          <AvatarImage
                            src={firstEntry.consultant.image || undefined}
                          />
                          <AvatarFallback className="text-[8px]">
                            {firstEntry.consultant.name?.[0] || "?"}
                          </AvatarFallback>
                        </Avatar>
                        {firstEntry.consultant.name}
                      </span>
                    )}
                    {firstEntry?.scheduledDate && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5" />
                        {format(
                          new Date(firstEntry.scheduledDate),
                          "MMM d, yyyy 'at' h:mm a",
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {notifiedCount > 0 && (
                  <Badge variant="secondary">
                    <Bell className="h-3 w-3 mr-1" />
                    {notifiedCount} notified
                  </Badge>
                )}
                {waitingCount > 0 && (
                  <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
                    <Clock className="h-3 w-3 mr-1" />
                    {waitingCount} waiting
                  </Badge>
                )}
                <Badge variant="secondary">{entries.length} total</Badge>
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <ResponsiveTable<WaitlistEntry>
              columns={groupedColumns}
              rows={entries}
              getRowId={(e) => e.id}
            />
            <div className="mt-3 pt-3 border-t">
              <Link
                href={`/explore/programs/plans/${firstEntry?.eventType === "class" ? "classes" : "webinars"}/${firstEntry?.planId}`}
                className="text-sm text-foreground underline-offset-4 hover:underline"
              >
                View Event Page →
              </Link>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function WaitlistManagement() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");
  const [timelineFilter, setTimelineFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [viewMode, setViewMode] = useState<"grouped" | "list">("grouped");
  const [currentPage, setCurrentPage] = useState(1);

  const { data, isLoading, error } = useQuery<{
    waitlists: WaitlistEntry[];
    grouped: Record<string, WaitlistEntry[]> | null;
    total: number;
    filteredTotal: number;
    page: number;
    totalPages: number;
    stats: WaitlistStats;
  }>({
    queryKey: [
      "admin-waitlists",
      statusFilter,
      eventTypeFilter,
      timelineFilter,
      searchTerm,
      viewMode,
      currentPage,
    ],
    queryFn: () =>
      fetchWaitlists({
        status: statusFilter,
        eventType: eventTypeFilter,
        timeline: timelineFilter,
        search: searchTerm,
        groupBy: viewMode === "grouped" ? "event" : undefined,
        page: currentPage,
      }),
  });

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Waitlist Management" />
        <Card>
          <CardContent className="py-8">
            <p className="text-center text-red-500 dark:text-red-400">
              Failed to load waitlists. Please try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Waitlist Management"
        description="View and manage all waitlist entries across webinars and classes"
      />

      {/* Key Stats */}
      {data?.stats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="border-l-4 border-l-foreground">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Active Waitlists
                  </p>
                  <p className="text-3xl font-bold text-foreground">
                    {data.stats.active}
                  </p>
                </div>
                <div className="p-3 bg-muted rounded-full">
                  <AlertCircle className="h-6 w-6 text-foreground" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {data.stats.waiting} waiting, {data.stats.notified} notified
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Entries</p>
                  <p className="text-3xl font-bold">{data.stats.total}</p>
                </div>
                <div className="p-3 bg-muted rounded-full">
                  <Users className="h-6 w-6 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Booked</p>
                  <p className="text-3xl font-bold text-green-600 dark:text-green-400">
                    {data.stats.booked}
                  </p>
                </div>
                <div className="p-3 bg-muted rounded-full">
                  <CheckCircle className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Expired</p>
                  <p className="text-3xl font-bold text-muted-foreground">
                    {data.stats.expired}
                  </p>
                </div>
                <div className="p-3 bg-muted rounded-full">
                  <XCircle className="h-6 w-6 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="w-full min-w-0 flex-1 sm:max-w-xs">
              <Input
                placeholder="Search by name or email..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-[140px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value={WaitlistStatus.WAITING}>Waiting</SelectItem>
                <SelectItem value={WaitlistStatus.NOTIFIED}>
                  Notified
                </SelectItem>
                <SelectItem value={WaitlistStatus.BOOKED}>Booked</SelectItem>
                <SelectItem value={WaitlistStatus.EXPIRED}>Expired</SelectItem>
                <SelectItem value={WaitlistStatus.CANCELLED}>
                  Cancelled
                </SelectItem>
                <SelectItem value={WaitlistStatus.SKIPPED}>Skipped</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={eventTypeFilter}
              onValueChange={(value) => {
                setEventTypeFilter(value);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-[130px]">
                <SelectValue placeholder="Event Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="webinar">Webinars</SelectItem>
                <SelectItem value="class">Classes</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={timelineFilter}
              onValueChange={(value) => {
                setTimelineFilter(value);
                setCurrentPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-[130px]">
                <SelectValue placeholder="Timeline" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Events</SelectItem>
                <SelectItem value="upcoming">Upcoming</SelectItem>
                <SelectItem value="past">Past</SelectItem>
              </SelectContent>
            </Select>
            <div className="ml-auto">
              <Tabs
                value={viewMode}
                onValueChange={(v) => setViewMode(v as "grouped" | "list")}
              >
                <TabsList className="h-9">
                  <TabsTrigger value="grouped" className="px-3">
                    <LayoutGrid className="h-4 w-4 mr-1" />
                    Grouped
                  </TabsTrigger>
                  <TabsTrigger value="list" className="px-3">
                    <LayoutList className="h-4 w-4 mr-1" />
                    List
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      ) : viewMode === "grouped" && data?.grouped ? (
        <div>
          {Object.keys(data.grouped).length > 0 ? (
            Object.entries(data.grouped)
              .sort(([, a], [, b]) => {
                // Sort by number of active entries (notified + waiting)
                const aActive = a.filter(
                  (e) => e.status === "WAITING" || e.status === "NOTIFIED",
                ).length;
                const bActive = b.filter(
                  (e) => e.status === "WAITING" || e.status === "NOTIFIED",
                ).length;
                return bActive - aActive;
              })
              .map(([eventTitle, entries], index) => (
                <EventGroupCard
                  key={eventTitle}
                  eventTitle={eventTitle}
                  entries={entries}
                  defaultOpen={index === 0}
                />
              ))
          ) : (
            <Card>
              <CardContent className="py-16 text-center">
                <div className="mx-auto h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <Users className="h-8 w-8 text-muted-foreground/70" />
                </div>
                <h3 className="font-semibold text-foreground text-lg">
                  No Waitlist Entries
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {searchTerm ||
                  statusFilter !== "all" ||
                  eventTypeFilter !== "all"
                    ? "No entries match your filters"
                    : "No one is currently on any waitlists"}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              All Entries{" "}
              {data?.filteredTotal !== undefined && `(${data.filteredTotal})`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveTable<WaitlistEntry>
              columns={listColumns}
              rows={data?.waitlists ?? []}
              getRowId={(e) => e.id}
              empty={
                <div className="py-16 text-center">
                  <div className="mx-auto h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                    <Users className="h-8 w-8 text-muted-foreground/70" />
                  </div>
                  <h3 className="font-semibold text-foreground text-lg">
                    No Waitlist Entries
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {searchTerm ||
                    statusFilter !== "all" ||
                    eventTypeFilter !== "all"
                      ? "No entries match your filters"
                      : "No one is currently on any waitlists"}
                  </p>
                </div>
              }
            />

            {/* Pagination */}
            {data?.waitlists &&
              data.waitlists.length > 0 &&
              data?.totalPages &&
              data.totalPages > 1 && (
                <div className="flex justify-center gap-2 mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <span className="py-2 px-3 text-sm text-muted-foreground">
                    Page {currentPage} of {data.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage >= data.totalPages}
                    onClick={() => setCurrentPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
