"use client";

import { useState, useEffect, useCallback } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Video,
  Users,
  Monitor,
  BookOpen,
  MoreHorizontal,
  Eye,
  RefreshCw,
  Loader2,
  ArrowUpRight,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

// Types
interface Appointment {
  id: string;
  type: string;
  title: string;
  consultant: {
    id: string;
    name: string | null;
    email: string | null;
    avatar: string | null;
  } | null;
  consultee: {
    id: string;
    name: string | null;
    email: string | null;
    avatar: string | null;
  } | null;
  scheduledAt: string;
  endsAt?: string;
  duration: number;
  status: string;
  hasIssue: boolean;
  issueType: string | null;
  payment: {
    id: string;
    amount: number;
    currency: string;
    status: string;
    gateway: string;
  } | null;
  createdAt: string;
}

interface AppointmentResponse {
  appointments: Appointment[];
  counts: {
    all: number;
    issues: number;
    scheduled: number;
    completed: number;
  };
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
}

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

const getTypeColor = (type: string) => {
  switch (type.toLowerCase()) {
    case "consultation":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "subscription":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "webinar":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    case "class":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "scheduled":
      return "bg-muted text-foreground";
    case "in_progress":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "completed":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "cancelled":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatFullDate = (dateString: string) => {
  return new Date(dateString).toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatCurrency = (amount: number, currency: string = "INR") => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency,
    maximumFractionDigits: 0,
  }).format(amount / 100);
};

export default function AppointmentsPage() {
  const { toast } = useToast();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({
    all: 0,
    issues: 0,
    scheduled: 0,
    completed: 0,
  });

  const [activeTab, setActiveTab] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedAppointment, setSelectedAppointment] =
    useState<Appointment | null>(null);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchAppointments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      if (typeFilter !== "all") params.set("type", typeFilter.toUpperCase());
      if (activeTab !== "all") params.set("status", activeTab);
      if (debouncedSearch) params.set("search", debouncedSearch);

      const response = await fetch(`/api/staff/appointments?${params}`);
      if (!response.ok) throw new Error("Failed to fetch appointments");

      const data: AppointmentResponse = await response.json();
      setAppointments(data.appointments);
      setCounts(data.counts);
      setTotalPages(data.pagination.totalPages);
    } catch (error) {
      console.error("Error fetching appointments:", error);
      toast({
        title: "Error",
        description: "Failed to load appointments",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter, activeTab, debouncedSearch, toast]);

  useEffect(() => {
    fetchAppointments();
  }, [fetchAppointments]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Appointments Management"
        description="Monitor and manage all scheduled appointments"
        actions={
          <Button
            variant="outline"
            onClick={fetchAppointments}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Calendar className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{counts.all}</p>
              <p className="text-sm text-muted-foreground">Total Appointments</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <AlertTriangle className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{counts.issues}</p>
              <p className="text-sm text-muted-foreground">Issues (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Clock className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{counts.scheduled}</p>
              <p className="text-sm text-muted-foreground">Scheduled (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <CheckCircle2 className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{counts.completed}</p>
              <p className="text-sm text-muted-foreground">Completed (page)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs and Filters */}
      <div className="space-y-4">
        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v);
            setPage(1);
          }}
        >
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
              <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
              <TabsTrigger value="completed">Completed</TabsTrigger>
            </TabsList>

            <div className="flex gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select
                value={typeFilter}
                onValueChange={(v) => {
                  setTypeFilter(v);
                  setPage(1);
                }}
              >
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
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : appointments.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <Calendar className="h-12 w-12 mb-4 text-muted-foreground/40" />
                  <p>No appointments found</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {appointments.map((appointment) => {
                  const TypeIcon = getTypeIcon(appointment.type);
                  return (
                    <Card
                      key={appointment.id}
                      className={`cursor-pointer hover:shadow-md transition-shadow ${
                        appointment.hasIssue
                          ? "border-amber-200 bg-amber-50/30 dark:border-amber-800 dark:bg-amber-950/20"
                          : ""
                      }`}
                      onClick={() => setSelectedAppointment(appointment)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <div
                              className={`p-2 rounded-lg ${getTypeColor(appointment.type)}`}
                            >
                              <TypeIcon className="h-4 w-4" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-medium">
                                  {appointment.title}
                                </p>
                                <Badge
                                  className={getTypeColor(appointment.type)}
                                  variant="secondary"
                                >
                                  {appointment.type}
                                </Badge>
                                <Badge
                                  className={getStatusColor(appointment.status)}
                                  variant="secondary"
                                >
                                  {appointment.status.replace("_", " ")}
                                </Badge>
                                {appointment.hasIssue && (
                                  <Badge variant="destructive">
                                    <AlertTriangle className="h-3 w-3 mr-1" />
                                    {appointment.issueType}
                                  </Badge>
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
                                  {formatDate(appointment.scheduledAt)}
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
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              asChild
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem>
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
                              </DropdownMenuItem>
                              <DropdownMenuItem>
                                <Users className="h-4 w-4 mr-2" />
                                Contact Participants
                              </DropdownMenuItem>
                              {appointment.hasIssue && (
                                <DropdownMenuItem>
                                  <AlertTriangle className="h-4 w-4 mr-2" />
                                  Resolve Issue
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex justify-center gap-2 mt-4">
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span className="flex items-center px-4 text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
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
                  <Badge
                    className={getStatusColor(selectedAppointment.status)}
                    variant="secondary"
                  >
                    {selectedAppointment.status.replace("_", " ")}
                  </Badge>
                  <Badge
                    className={getTypeColor(selectedAppointment.type)}
                    variant="secondary"
                  >
                    {selectedAppointment.type}
                  </Badge>
                  {selectedAppointment.hasIssue && (
                    <Badge variant="destructive">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {selectedAppointment.issueType}
                    </Badge>
                  )}
                </div>

                {/* Participants */}
                <div className="grid gap-4 sm:grid-cols-2">
                  {selectedAppointment.consultant && (
                    <div className="p-3 rounded-lg bg-muted">
                      <Label className="text-xs text-muted-foreground">
                        Consultant
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
                        Consultee
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
                    <p>{formatFullDate(selectedAppointment.scheduledAt)}</p>
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

                {/* Staff Notes */}
                <div>
                  <Label htmlFor="note">Staff Note</Label>
                  <Textarea
                    id="note"
                    placeholder="Add a note about this appointment..."
                    className="mt-1"
                  />
                </div>
              </div>
              <ResponsiveModalFooter>
                <Button
                  variant="outline"
                  onClick={() => setSelectedAppointment(null)}
                >
                  Close
                </Button>
                <Button variant="outline">
                  <ArrowUpRight className="h-4 w-4 mr-2" />
                  Escalate to Admin
                </Button>
              </ResponsiveModalFooter>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
