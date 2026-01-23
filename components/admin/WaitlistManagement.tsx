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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

  const response = await fetch(`/api/admin/waitlists?${queryParams.toString()}`);
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
        <Badge className="bg-amber-100 text-amber-800 border-amber-200">
          <Clock className={iconClass} />
          {!compact && "Waiting"}
        </Badge>
      );
    case "NOTIFIED":
      return (
        <Badge className="bg-blue-100 text-blue-800 border-blue-200">
          <Bell className={iconClass} />
          {!compact && "Notified"}
        </Badge>
      );
    case "BOOKED":
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200">
          <CheckCircle className={iconClass} />
          {!compact && "Booked"}
        </Badge>
      );
    case "EXPIRED":
      return (
        <Badge className="bg-gray-100 text-gray-600 border-gray-200">
          <XCircle className={iconClass} />
          {!compact && "Expired"}
        </Badge>
      );
    case "CANCELLED":
      return (
        <Badge className="bg-red-100 text-red-800 border-red-200">
          <XCircle className={iconClass} />
          {!compact && "Cancelled"}
        </Badge>
      );
    case "SKIPPED":
      return (
        <Badge className="bg-purple-100 text-purple-800 border-purple-200">
          <SkipForward className={iconClass} />
          {!compact && "Skipped"}
        </Badge>
      );
    default:
      return <Badge>{status}</Badge>;
  }
};

function WaitlistTableRow({ entry }: { entry: WaitlistEntry }) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarImage
              src={entry.user.image || undefined}
              alt={entry.user.name || "User"}
            />
            <AvatarFallback className="bg-zinc-100 text-zinc-600 text-xs">
              {entry.user.name
                ?.split(" ")
                .map((n) => n[0])
                .join("")
                .slice(0, 2) || "??"}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="font-medium text-sm">{entry.user.name || "No name"}</p>
            <p className="text-xs text-gray-500">{entry.user.email}</p>
          </div>
        </div>
      </TableCell>
      <TableCell>{getStatusBadge(entry.status)}</TableCell>
      <TableCell>
        {entry.position ? (
          <span className="font-semibold text-amber-700">#{entry.position}</span>
        ) : (
          <span className="text-gray-400">-</span>
        )}
      </TableCell>
      <TableCell className="text-sm text-gray-600">
        {format(new Date(entry.joinedAt), "MMM d, yyyy")}
      </TableCell>
      <TableCell className="text-sm">
        {entry.expiresAt ? (
          <span
            className={
              new Date(entry.expiresAt) < new Date()
                ? "text-red-600"
                : "text-gray-600"
            }
          >
            {format(new Date(entry.expiresAt), "MMM d, h:mm a")}
          </span>
        ) : (
          "-"
        )}
      </TableCell>
    </TableRow>
  );
}

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
          <CardHeader className="cursor-pointer hover:bg-gray-50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                {isOpen ? (
                  <ChevronDown className="h-5 w-5 text-gray-500" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-gray-500" />
                )}
                <div>
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-base">{eventTitle}</CardTitle>
                    <Badge variant="outline" className="capitalize text-xs">
                      {firstEntry?.eventType}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
                    {firstEntry?.consultant && (
                      <span className="flex items-center gap-1">
                        <Avatar className="h-4 w-4">
                          <AvatarImage src={firstEntry.consultant.image || undefined} />
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
                        {format(new Date(firstEntry.scheduledDate), "MMM d, yyyy 'at' h:mm a")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {notifiedCount > 0 && (
                  <Badge className="bg-blue-100 text-blue-800">
                    <Bell className="h-3 w-3 mr-1" />
                    {notifiedCount} notified
                  </Badge>
                )}
                {waitingCount > 0 && (
                  <Badge className="bg-amber-100 text-amber-800">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <WaitlistTableRow key={entry.id} entry={entry} />
                ))}
              </TableBody>
            </Table>
            <div className="mt-3 pt-3 border-t">
              <Link
                href={`/explore/programs/plans/${firstEntry?.eventType}s/${firstEntry?.planId}`}
                className="text-sm text-blue-600 hover:underline"
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
        <h1 className="text-3xl font-bold text-gray-900">Waitlist Management</h1>
        <Card>
          <CardContent className="py-8">
            <p className="text-center text-red-500">
              Failed to load waitlists. Please try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Waitlist Management</h1>
        <p className="text-gray-600 mt-1">
          View and manage all waitlist entries across webinars and classes
        </p>
      </div>

      {/* Key Stats */}
      {data?.stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="border-l-4 border-l-amber-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Active Waitlists</p>
                  <p className="text-3xl font-bold text-amber-600">
                    {data.stats.active}
                  </p>
                </div>
                <div className="p-3 bg-amber-100 rounded-full">
                  <AlertCircle className="h-6 w-6 text-amber-600" />
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {data.stats.waiting} waiting, {data.stats.notified} notified
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Total Entries</p>
                  <p className="text-3xl font-bold">{data.stats.total}</p>
                </div>
                <div className="p-3 bg-gray-100 rounded-full">
                  <Users className="h-6 w-6 text-gray-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Booked</p>
                  <p className="text-3xl font-bold text-green-600">
                    {data.stats.booked}
                  </p>
                </div>
                <div className="p-3 bg-green-100 rounded-full">
                  <CheckCircle className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Expired</p>
                  <p className="text-3xl font-bold text-gray-500">
                    {data.stats.expired}
                  </p>
                </div>
                <div className="p-3 bg-gray-100 rounded-full">
                  <XCircle className="h-6 w-6 text-gray-500" />
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
            <div className="flex-1 min-w-[200px] max-w-xs">
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
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value={WaitlistStatus.WAITING}>Waiting</SelectItem>
                <SelectItem value={WaitlistStatus.NOTIFIED}>Notified</SelectItem>
                <SelectItem value={WaitlistStatus.BOOKED}>Booked</SelectItem>
                <SelectItem value={WaitlistStatus.EXPIRED}>Expired</SelectItem>
                <SelectItem value={WaitlistStatus.CANCELLED}>Cancelled</SelectItem>
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
              <SelectTrigger className="w-[130px]">
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
              <SelectTrigger className="w-[130px]">
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
                  (e) => e.status === "WAITING" || e.status === "NOTIFIED"
                ).length;
                const bActive = b.filter(
                  (e) => e.status === "WAITING" || e.status === "NOTIFIED"
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
                <div className="mx-auto h-16 w-16 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
                  <Users className="h-8 w-8 text-gray-400" />
                </div>
                <h3 className="font-semibold text-gray-900 text-lg">
                  No Waitlist Entries
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  {searchTerm || statusFilter !== "all" || eventTypeFilter !== "all"
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
              All Entries {data?.filteredTotal !== undefined && `(${data.filteredTotal})`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data?.waitlists && data.waitlists.length > 0 ? (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Scheduled</TableHead>
                      <TableHead>Joined</TableHead>
                      <TableHead>Expires</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.waitlists.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="h-8 w-8">
                              <AvatarImage
                                src={entry.user.image || undefined}
                                alt={entry.user.name || "User"}
                              />
                              <AvatarFallback className="bg-zinc-100 text-zinc-600 text-xs">
                                {entry.user.name
                                  ?.split(" ")
                                  .map((n) => n[0])
                                  .join("")
                                  .slice(0, 2) || "??"}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium text-sm">
                                {entry.user.name || "No name"}
                              </p>
                              <p className="text-xs text-gray-500">
                                {entry.user.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Link
                            href={`/explore/programs/plans/${entry.eventType}s/${entry.planId}`}
                            className="text-blue-600 hover:underline text-sm"
                          >
                            {entry.eventTitle}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize text-xs">
                            {entry.eventType}
                          </Badge>
                        </TableCell>
                        <TableCell>{getStatusBadge(entry.status)}</TableCell>
                        <TableCell>
                          {entry.position ? (
                            <span className="font-semibold text-amber-700">
                              #{entry.position}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-gray-600">
                          {entry.scheduledDate
                            ? format(new Date(entry.scheduledDate), "MMM d, yyyy")
                            : "-"}
                        </TableCell>
                        <TableCell className="text-sm text-gray-600">
                          {format(new Date(entry.joinedAt), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell className="text-sm">
                          {entry.expiresAt ? (
                            <span
                              className={
                                new Date(entry.expiresAt) < new Date()
                                  ? "text-red-600"
                                  : "text-gray-600"
                              }
                            >
                              {format(new Date(entry.expiresAt), "MMM d, h:mm a")}
                            </span>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* Pagination */}
                {data?.totalPages && data.totalPages > 1 && (
                  <div className="flex justify-center gap-2 mt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage((p) => p - 1)}
                    >
                      Previous
                    </Button>
                    <span className="py-2 px-3 text-sm text-gray-600">
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
              </>
            ) : (
              <div className="py-16 text-center">
                <div className="mx-auto h-16 w-16 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
                  <Users className="h-8 w-8 text-gray-400" />
                </div>
                <h3 className="font-semibold text-gray-900 text-lg">
                  No Waitlist Entries
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  {searchTerm || statusFilter !== "all" || eventTypeFilter !== "all"
                    ? "No entries match your filters"
                    : "No one is currently on any waitlists"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default WaitlistManagement;
