"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Search,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  Video,
  RefreshCw,
  User,
  Users,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Mock data
const appointments = [
  {
    id: "APT-001",
    type: "consultation",
    consultant: { name: "Dr. Jane Smith", avatar: "" },
    consultee: { name: "John Doe", avatar: "" },
    scheduledAt: "2025-12-21T10:00:00",
    duration: 60,
    status: "scheduled",
    hasIssue: false,
  },
  {
    id: "APT-002",
    type: "webinar",
    consultant: { name: "Mike Wilson", avatar: "" },
    consultee: { name: "Multiple Attendees", avatar: "" },
    scheduledAt: "2025-12-21T14:00:00",
    duration: 90,
    status: "issue",
    hasIssue: true,
    issueType: "Technical problem reported",
  },
  {
    id: "APT-003",
    type: "consultation",
    consultant: { name: "Dr. Priya Sharma", avatar: "" },
    consultee: { name: "Sarah Connor", avatar: "" },
    scheduledAt: "2025-12-20T16:00:00",
    duration: 45,
    status: "completed",
    hasIssue: false,
  },
  {
    id: "APT-004",
    type: "class",
    consultant: { name: "Alex Brown", avatar: "" },
    consultee: { name: "Multiple Students", avatar: "" },
    scheduledAt: "2025-12-20T11:00:00",
    duration: 120,
    status: "cancelled",
    hasIssue: true,
    issueType: "Consultant no-show",
  },
  {
    id: "APT-005",
    type: "consultation",
    consultant: { name: "Dr. Rajesh Kumar", avatar: "" },
    consultee: { name: "Emily Chen", avatar: "" },
    scheduledAt: "2025-12-22T09:00:00",
    duration: 60,
    status: "reschedule_requested",
    hasIssue: true,
    issueType: "Reschedule request pending",
  },
];

const issues = [
  {
    id: "ISS-001",
    appointmentId: "APT-002",
    type: "technical",
    description: "User unable to join video call - black screen issue",
    reportedBy: "John Doe",
    status: "open",
    createdAt: "2025-12-20T14:30:00",
    priority: "high",
  },
  {
    id: "ISS-002",
    appointmentId: "APT-004",
    type: "no_show",
    description: "Consultant did not join the scheduled class session",
    reportedBy: "System",
    status: "open",
    createdAt: "2025-12-20T11:15:00",
    priority: "high",
  },
  {
    id: "ISS-003",
    appointmentId: "APT-005",
    type: "reschedule",
    description: "Consultee requested reschedule due to emergency",
    reportedBy: "Emily Chen",
    status: "pending",
    createdAt: "2025-12-20T08:00:00",
    priority: "medium",
  },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case "scheduled":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "in_progress":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "completed":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
    case "cancelled":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "issue":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    case "reschedule_requested":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getTypeColor = (type: string) => {
  switch (type) {
    case "consultation":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "webinar":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "class":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300";
    case "subscription":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getPriorityColor = (priority: string) => {
  switch (priority) {
    case "high":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "medium":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    case "low":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
    default:
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  }
};

const formatDateTime = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export default function AppointmentsSupportPage() {
  const [activeTab, setActiveTab] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedAppointment, setSelectedAppointment] = useState<typeof appointments[0] | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<typeof issues[0] | null>(null);

  const filteredAppointments = appointments.filter((apt) => {
    const matchesSearch =
      apt.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      apt.consultant.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      apt.consultee.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || apt.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const appointmentCounts = {
    all: appointments.length,
    issues: appointments.filter((a) => a.hasIssue).length,
    scheduled: appointments.filter((a) => a.status === "scheduled").length,
    completed: appointments.filter((a) => a.status === "completed").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Appointments Support
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            Manage appointment issues and support requests
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950">
              <Calendar className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{appointmentCounts.all}</p>
              <p className="text-sm text-zinc-500">Total Appointments</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{appointmentCounts.issues}</p>
              <p className="text-sm text-zinc-500">With Issues</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950">
              <Clock className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{appointmentCounts.scheduled}</p>
              <p className="text-sm text-zinc-500">Upcoming</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{appointmentCounts.completed}</p>
              <p className="text-sm text-zinc-500">Completed</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">All Appointments</TabsTrigger>
          <TabsTrigger value="issues" className="gap-2">
            Issues
            <Badge variant="destructive" className="ml-1">
              {issues.filter((i) => i.status === "open").length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        {/* All Appointments Tab */}
        <TabsContent value="all" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <Input
                    placeholder="Search by ID, consultant, or consultee..."
                    className="pl-9"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                    <SelectItem value="issue">Has Issue</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Consultant</TableHead>
                    <TableHead>Consultee</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAppointments.map((apt) => (
                    <TableRow
                      key={apt.id}
                      className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                      onClick={() => setSelectedAppointment(apt)}
                    >
                      <TableCell className="font-mono text-sm">
                        <div className="flex items-center gap-2">
                          {apt.hasIssue && (
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                          )}
                          {apt.id}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={getTypeColor(apt.type)} variant="secondary">
                          {apt.type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            <AvatarImage src={apt.consultant.avatar} />
                            <AvatarFallback className="text-xs">
                              {apt.consultant.name.split(" ").map((n) => n[0]).join("")}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm">{apt.consultant.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {apt.consultee.name.includes("Multiple") ? (
                            <Users className="h-4 w-4 text-zinc-400" />
                          ) : (
                            <Avatar className="h-6 w-6">
                              <AvatarImage src={apt.consultee.avatar} />
                              <AvatarFallback className="text-xs">
                                {apt.consultee.name.split(" ").map((n) => n[0]).join("")}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <span className="text-sm">{apt.consultee.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatDateTime(apt.scheduledAt)}
                      </TableCell>
                      <TableCell className="text-sm text-zinc-500">
                        {apt.duration} min
                      </TableCell>
                      <TableCell>
                        <Badge className={getStatusColor(apt.status)} variant="secondary">
                          {apt.status.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem>
                              <Video className="h-4 w-4 mr-2" />
                              Join Meeting
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Reschedule
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-red-600">
                              <XCircle className="h-4 w-4 mr-2" />
                              Cancel
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Issues Tab */}
        <TabsContent value="issues" className="space-y-4">
          <div className="space-y-3">
            {issues.map((issue) => (
              <Card
                key={issue.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setSelectedIssue(issue)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950">
                        <AlertTriangle className="h-5 w-5 text-amber-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{issue.id}</p>
                          <Badge variant="outline">Apt: {issue.appointmentId}</Badge>
                          <Badge className={getPriorityColor(issue.priority)} variant="secondary">
                            {issue.priority}
                          </Badge>
                        </div>
                        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                          {issue.description}
                        </p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
                          <span>Type: {issue.type.replace("_", " ")}</span>
                          <span>Reported by: {issue.reportedBy}</span>
                          <span>Status: {issue.status}</span>
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-zinc-400">
                      {formatDateTime(issue.createdAt)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* Appointment Detail Dialog */}
      <Dialog open={!!selectedAppointment} onOpenChange={() => setSelectedAppointment(null)}>
        <DialogContent className="max-w-2xl">
          {selectedAppointment && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  Appointment {selectedAppointment.id}
                </DialogTitle>
                <DialogDescription>
                  View and manage appointment details
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Badge className={getTypeColor(selectedAppointment.type)} variant="secondary">
                    {selectedAppointment.type}
                  </Badge>
                  <Badge className={getStatusColor(selectedAppointment.status)} variant="secondary">
                    {selectedAppointment.status.replace("_", " ")}
                  </Badge>
                  {selectedAppointment.hasIssue && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      {selectedAppointment.issueType}
                    </Badge>
                  )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                    <Label className="text-xs text-zinc-500">Consultant</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>
                          {selectedAppointment.consultant.name.split(" ").map((n) => n[0]).join("")}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{selectedAppointment.consultant.name}</span>
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                    <Label className="text-xs text-zinc-500">Consultee</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>
                          {selectedAppointment.consultee.name.split(" ").map((n) => n[0]).join("")}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{selectedAppointment.consultee.name}</span>
                    </div>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="text-sm text-zinc-500">Scheduled Time</Label>
                    <p className="font-medium">{formatDateTime(selectedAppointment.scheduledAt)}</p>
                  </div>
                  <div>
                    <Label className="text-sm text-zinc-500">Duration</Label>
                    <p className="font-medium">{selectedAppointment.duration} minutes</p>
                  </div>
                </div>
                <div>
                  <Label htmlFor="note">Staff Note</Label>
                  <Textarea
                    id="note"
                    placeholder="Add a note about this appointment..."
                    className="mt-1"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setSelectedAppointment(null)}>
                  Close
                </Button>
                <Button variant="outline">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Reschedule
                </Button>
                <Button>
                  <Video className="h-4 w-4 mr-2" />
                  Join Meeting
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Issue Detail Dialog */}
      <Dialog open={!!selectedIssue} onOpenChange={() => setSelectedIssue(null)}>
        <DialogContent>
          {selectedIssue && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  Issue {selectedIssue.id}
                </DialogTitle>
                <DialogDescription>
                  Review and resolve this issue
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Appointment: {selectedIssue.appointmentId}</Badge>
                  <Badge className={getPriorityColor(selectedIssue.priority)} variant="secondary">
                    {selectedIssue.priority} priority
                  </Badge>
                </div>
                <div>
                  <Label className="text-sm text-zinc-500">Issue Type</Label>
                  <p className="font-medium capitalize">{selectedIssue.type.replace("_", " ")}</p>
                </div>
                <div>
                  <Label className="text-sm text-zinc-500">Description</Label>
                  <p className="text-sm">{selectedIssue.description}</p>
                </div>
                <div>
                  <Label className="text-sm text-zinc-500">Reported By</Label>
                  <p className="text-sm">{selectedIssue.reportedBy}</p>
                </div>
                <div>
                  <Label htmlFor="resolution">Resolution Notes</Label>
                  <Textarea
                    id="resolution"
                    placeholder="Describe how the issue was resolved..."
                    className="mt-1"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setSelectedIssue(null)}>
                  Cancel
                </Button>
                <Button>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Mark Resolved
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

