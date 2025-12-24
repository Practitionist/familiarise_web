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
  Filter,
  Plus,
  MessageSquare,
  Clock,
  User,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Mock data
const tickets = [
  {
    id: "TKT-001",
    subject: "Payment not processed",
    description: "My payment was declined but amount was deducted from my account.",
    user: { name: "John Doe", email: "john@example.com", avatar: "" },
    status: "open",
    priority: "high",
    category: "payment",
    createdAt: "2025-12-20T10:30:00",
    updatedAt: "2025-12-20T10:30:00",
    assignedTo: null,
    messages: 3,
  },
  {
    id: "TKT-002",
    subject: "Cannot schedule appointment",
    description: "The calendar is not loading when I try to book a consultation.",
    user: { name: "Jane Smith", email: "jane@example.com", avatar: "" },
    status: "in_progress",
    priority: "medium",
    category: "technical",
    createdAt: "2025-12-20T09:15:00",
    updatedAt: "2025-12-20T11:00:00",
    assignedTo: "Staff Member",
    messages: 5,
  },
  {
    id: "TKT-003",
    subject: "Profile verification issue",
    description: "My consultant profile is pending verification for over a week.",
    user: { name: "Mike Wilson", email: "mike@example.com", avatar: "" },
    status: "pending",
    priority: "low",
    category: "account",
    createdAt: "2025-12-19T14:00:00",
    updatedAt: "2025-12-20T08:00:00",
    assignedTo: "Staff Member",
    messages: 2,
  },
  {
    id: "TKT-004",
    subject: "Refund request for cancelled session",
    description: "The consultant cancelled the session but I haven't received my refund.",
    user: { name: "Sarah Connor", email: "sarah@example.com", avatar: "" },
    status: "open",
    priority: "high",
    category: "refund",
    createdAt: "2025-12-20T08:00:00",
    updatedAt: "2025-12-20T08:00:00",
    assignedTo: null,
    messages: 1,
  },
  {
    id: "TKT-005",
    subject: "Unable to join video call",
    description: "Getting a black screen when trying to join the consultation.",
    user: { name: "Alex Brown", email: "alex@example.com", avatar: "" },
    status: "resolved",
    priority: "medium",
    category: "technical",
    createdAt: "2025-12-18T16:30:00",
    updatedAt: "2025-12-19T10:00:00",
    assignedTo: "Staff Member",
    messages: 8,
  },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case "open":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "in_progress":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "pending":
      return "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300";
    case "resolved":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "closed":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
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

const getStatusIcon = (status: string) => {
  switch (status) {
    case "open":
      return <AlertCircle className="h-4 w-4 text-blue-500" />;
    case "in_progress":
      return <Clock className="h-4 w-4 text-yellow-500" />;
    case "pending":
      return <Clock className="h-4 w-4 text-orange-500" />;
    case "resolved":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "closed":
      return <XCircle className="h-4 w-4 text-zinc-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-zinc-500" />;
  }
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
};

export default function SupportTicketsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [selectedTicket, setSelectedTicket] = useState<typeof tickets[0] | null>(null);
  const [replyText, setReplyText] = useState("");

  const filteredTickets = tickets.filter((ticket) => {
    const matchesSearch =
      ticket.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ticket.user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ticket.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || ticket.status === statusFilter;
    const matchesPriority = priorityFilter === "all" || ticket.priority === priorityFilter;
    return matchesSearch && matchesStatus && matchesPriority;
  });

  const ticketCounts = {
    all: tickets.length,
    open: tickets.filter((t) => t.status === "open").length,
    in_progress: tickets.filter((t) => t.status === "in_progress").length,
    pending: tickets.filter((t) => t.status === "pending").length,
    resolved: tickets.filter((t) => t.status === "resolved").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Support Tickets
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            Manage and respond to user support requests
          </p>
        </div>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          Create Ticket
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-5">
        {[
          { label: "All", value: ticketCounts.all, color: "text-zinc-600" },
          { label: "Open", value: ticketCounts.open, color: "text-blue-600" },
          { label: "In Progress", value: ticketCounts.in_progress, color: "text-yellow-600" },
          { label: "Pending", value: ticketCounts.pending, color: "text-orange-600" },
          { label: "Resolved", value: ticketCounts.resolved, color: "text-green-600" },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
              <p className="text-sm text-zinc-500">{stat.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input
                placeholder="Search tickets by ID, subject, or user..."
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
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
            <Select value={priorityFilter} onValueChange={setPriorityFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Priority</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Tickets Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Ticket ID</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTickets.map((ticket) => (
                <TableRow
                  key={ticket.id}
                  className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  onClick={() => setSelectedTicket(ticket)}
                >
                  <TableCell className="font-mono text-sm">{ticket.id}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {getStatusIcon(ticket.status)}
                      <span className="font-medium">{ticket.subject}</span>
                      {ticket.messages > 0 && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <MessageSquare className="h-3 w-3" />
                          {ticket.messages}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={ticket.user.avatar} />
                        <AvatarFallback className="text-xs">
                          {ticket.user.name.split(" ").map((n) => n[0]).join("")}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm">{ticket.user.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={getStatusColor(ticket.status)} variant="secondary">
                      {ticket.status.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={getPriorityColor(ticket.priority)} variant="secondary">
                      {ticket.priority}
                    </Badge>
                  </TableCell>
                  <TableCell className="capitalize text-sm text-zinc-600 dark:text-zinc-400">
                    {ticket.category}
                  </TableCell>
                  <TableCell className="text-sm text-zinc-500">
                    {formatDate(ticket.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem>Assign to me</DropdownMenuItem>
                        <DropdownMenuItem>Change status</DropdownMenuItem>
                        <DropdownMenuItem>Change priority</DropdownMenuItem>
                        <DropdownMenuItem className="text-red-600">Close ticket</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Ticket Detail Dialog */}
      <Dialog open={!!selectedTicket} onOpenChange={() => setSelectedTicket(null)}>
        <DialogContent className="max-w-2xl">
          {selectedTicket && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between">
                  <DialogTitle className="flex items-center gap-2">
                    {getStatusIcon(selectedTicket.status)}
                    {selectedTicket.subject}
                  </DialogTitle>
                  <Badge className={getPriorityColor(selectedTicket.priority)} variant="secondary">
                    {selectedTicket.priority}
                  </Badge>
                </div>
                <DialogDescription>
                  {selectedTicket.id} • Created {formatDate(selectedTicket.createdAt)}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {/* User Info */}
                <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                  <Avatar>
                    <AvatarImage src={selectedTicket.user.avatar} />
                    <AvatarFallback>
                      {selectedTicket.user.name.split(" ").map((n) => n[0]).join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{selectedTicket.user.name}</p>
                    <p className="text-sm text-zinc-500">{selectedTicket.user.email}</p>
                  </div>
                </div>

                {/* Description */}
                <div>
                  <Label className="text-sm font-medium">Description</Label>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    {selectedTicket.description}
                  </p>
                </div>

                {/* Status Update */}
                <div className="flex gap-2">
                  <Select defaultValue={selectedTicket.status}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="resolved">Resolved</SelectItem>
                      <SelectItem value="closed">Closed</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline">Update Status</Button>
                </div>

                {/* Reply */}
                <div>
                  <Label htmlFor="reply">Reply to User</Label>
                  <Textarea
                    id="reply"
                    placeholder="Type your response..."
                    className="mt-1"
                    rows={4}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setSelectedTicket(null)}>
                  Cancel
                </Button>
                <Button>Send Reply</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

