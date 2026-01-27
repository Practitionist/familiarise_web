"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useDebouncedCallback } from "use-debounce";
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
import { Separator } from "@/components/ui/separator";
import {
  Search,
  MessageSquare,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  RefreshCw,
  DollarSign,
  Calendar,
  Send,
  Loader2,
  CreditCard,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

interface TicketUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

interface TicketResponse {
  id: string;
  message: string;
  isInternal: boolean;
  createdAt: string;
  user: {
    name: string | null;
    role: string | null;
  } | null;
}

interface Ticket {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  category: string | null;
  issueType: string | null;
  user: TicketUser;
  responses: TicketResponse[];
  createdAt: string;
  updatedAt: string;
  linkedConsultation?: any;
  linkedSubscription?: any;
  linkedPayment?: any;
  linkedRefund?: any;
}

interface TicketCounts {
  total: number;
  open: number;
  inProgress: number;
  onHold: number;
  resolved: number;
  closed: number;
}

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "OPEN":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "IN_PROGRESS":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "ON_HOLD":
      return "bg-orange-100 text-orange-700 border-orange-200";
    case "RESOLVED":
      return "bg-green-100 text-green-700 border-green-200";
    case "CLOSED":
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
    default:
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
  }
};

const getPriorityColor = (priority: string) => {
  switch (priority.toUpperCase()) {
    case "URGENT":
    case "HIGH":
      return "bg-red-100 text-red-700 border-red-200";
    case "MEDIUM":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "LOW":
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
    default:
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toUpperCase()) {
    case "OPEN":
      return <AlertCircle className="h-4 w-4 text-blue-500" />;
    case "IN_PROGRESS":
      return <Clock className="h-4 w-4 text-yellow-500" />;
    case "ON_HOLD":
      return <Clock className="h-4 w-4 text-orange-500" />;
    case "RESOLVED":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "CLOSED":
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

const formatCurrency = (amount: number, currency: string) => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
  }).format(amount / 100);
};

const formatIssueType = (issueType: string | null) => {
  if (!issueType) return "-";
  return issueType.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
};

export default function AdminSupportTicketsPage() {
  const { toast } = useToast();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [counts, setCounts] = useState<TicketCounts>({
    total: 0,
    open: 0,
    inProgress: 0,
    onHold: 0,
    resolved: 0,
    closed: 0,
  });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [ticketDetail, setTicketDetail] = useState<Ticket | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [localSearchValue, setLocalSearchValue] = useState("");

  const debouncedSetSearch = useDebouncedCallback((value: string) => {
    setDebouncedSearch(value);
    setPage(1);
  }, 300);

  const handleSearchChange = (value: string) => {
    setLocalSearchValue(value);
    debouncedSetSearch(value);
  };

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
        ...(statusFilter !== "all" && { status: statusFilter }),
        ...(priorityFilter !== "all" && { priority: priorityFilter }),
        ...(debouncedSearch && { search: debouncedSearch }),
      });

      const response = await fetch(`/api/staff/support-tickets?${params}`);
      if (!response.ok) throw new Error("Failed to fetch tickets");

      const data = await response.json();
      setTickets(data.tickets);
      setCounts(data.counts);
      setTotalPages(data.pagination.totalPages);
    } catch (error) {
      console.error("Error fetching tickets:", error);
      toast({
        title: "Error",
        description: "Failed to load support tickets",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, priorityFilter, debouncedSearch, toast]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const fetchTicketDetail = async (ticketId: string) => {
    setLoadingDetail(true);
    try {
      const response = await fetch(`/api/staff/support-tickets/${ticketId}`);
      if (!response.ok) throw new Error("Failed to fetch ticket detail");
      const data = await response.json();
      setTicketDetail(data);
    } catch (error) {
      console.error("Error fetching ticket detail:", error);
      toast({
        title: "Error",
        description: "Failed to load ticket details",
        variant: "destructive",
      });
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleSelectTicket = async (ticket: Ticket) => {
    setSelectedTicket(ticket);
    await fetchTicketDetail(ticket.id);
  };

  const handleUpdateStatus = async (newStatus: string) => {
    if (!selectedTicket) return;
    setUpdatingStatus(true);
    try {
      const response = await fetch(
        `/api/staff/support-tickets/${selectedTicket.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        },
      );
      if (!response.ok) throw new Error("Failed to update status");
      toast({ title: "Success", description: "Status updated successfully" });
      fetchTickets();
      fetchTicketDetail(selectedTicket.id);
    } catch (error) {
      console.error("Error updating status:", error);
      toast({
        title: "Error",
        description: "Failed to update status",
        variant: "destructive",
      });
    } finally {
      setUpdatingStatus(false);
    }
  };

  const handleSendReply = async () => {
    if (!selectedTicket || !replyText.trim()) return;
    setSendingReply(true);
    try {
      const response = await fetch(
        `/api/staff/support-tickets/${selectedTicket.id}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: replyText,
            isInternal: isInternalNote,
          }),
        },
      );
      if (!response.ok) throw new Error("Failed to send reply");
      toast({
        title: "Success",
        description: isInternalNote ? "Internal note added" : "Reply sent",
      });
      setReplyText("");
      setIsInternalNote(false);
      fetchTicketDetail(selectedTicket.id);
      fetchTickets();
    } catch (error) {
      console.error("Error sending reply:", error);
      toast({
        title: "Error",
        description: "Failed to send reply",
        variant: "destructive",
      });
    } finally {
      setSendingReply(false);
    }
  };

  const handleQuickAction = async (
    ticketId: string,
    action: string,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    try {
      if (action === "close") {
        await fetch(`/api/staff/support-tickets/${ticketId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "CLOSED" }),
        });
        toast({ title: "Success", description: "Ticket closed" });
      } else if (action === "resolve") {
        await fetch(`/api/staff/support-tickets/${ticketId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "RESOLVED" }),
        });
        toast({ title: "Success", description: "Ticket resolved" });
      }
      fetchTickets();
    } catch (error) {
      console.error("Error:", error);
      toast({
        title: "Error",
        description: "Action failed",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Support Tickets
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Manage all customer support tickets
          </p>
        </div>
        <Button onClick={fetchTickets} variant="outline" size="sm">
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        {[
          { label: "Open", value: counts.open, color: "text-blue-600" },
          {
            label: "In Progress",
            value: counts.inProgress,
            color: "text-amber-600",
          },
          { label: "On Hold", value: counts.onHold, color: "text-orange-600" },
          {
            label: "Resolved",
            value: counts.resolved,
            color: "text-green-600",
          },
          { label: "Closed", value: counts.closed, color: "text-zinc-500" },
          {
            label: "Total",
            value: counts.total,
            color: "text-zinc-900 dark:text-zinc-100",
          },
        ].map((stat) => (
          <Card key={stat.label} className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">
                {stat.label}
              </p>
              <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input
                placeholder="Search tickets..."
                value={localSearchValue}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                <SelectItem value="ON_HOLD">On Hold</SelectItem>
                <SelectItem value="RESOLVED">Resolved</SelectItem>
                <SelectItem value="CLOSED">Closed</SelectItem>
              </SelectContent>
            </Select>
            <Select value={priorityFilter} onValueChange={setPriorityFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Priority</SelectItem>
                <SelectItem value="URGENT">Urgent</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
                <SelectItem value="MEDIUM">Medium</SelectItem>
                <SelectItem value="LOW">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Tickets Table */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : tickets.length === 0 ? (
            <div className="text-center py-12">
              <MessageSquare className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
              <p className="text-zinc-500">No tickets found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Ticket ID</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Issue Type</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((ticket) => (
                  <TableRow
                    key={ticket.id}
                    className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                    onClick={() => handleSelectTicket(ticket)}
                  >
                    <TableCell className="font-mono text-xs text-zinc-500">
                      {ticket.id.slice(0, 8).toUpperCase()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {getStatusIcon(ticket.status)}
                        <span className="font-medium truncate max-w-[200px]">
                          {ticket.title}
                        </span>
                        {ticket.responses?.length > 0 && (
                          <Badge variant="secondary" className="text-xs">
                            <MessageSquare className="h-3 w-3 mr-1" />
                            {ticket.responses.length}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-7 w-7">
                          <AvatarImage src={ticket.user?.image || ""} />
                          <AvatarFallback className="text-xs">
                            {ticket.user?.name?.charAt(0) || "U"}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm">
                          {ticket.user?.name || "Unknown"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={getStatusColor(ticket.status)}
                      >
                        {ticket.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={getPriorityColor(ticket.priority)}
                      >
                        {ticket.priority}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-zinc-500">
                      {formatIssueType(ticket.issueType)}
                    </TableCell>
                    <TableCell className="text-sm text-zinc-500">
                      {formatDate(ticket.updatedAt)}
                    </TableCell>
                    <TableCell>
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
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectTicket(ticket);
                            }}
                          >
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={(e) =>
                              handleQuickAction(ticket.id, "resolve", e)
                            }
                          >
                            Mark Resolved
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) =>
                              handleQuickAction(ticket.id, "close", e)
                            }
                          >
                            Close Ticket
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Previous
          </Button>
          <span className="text-sm text-zinc-500">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            Next
          </Button>
        </div>
      )}

      {/* Ticket Detail Dialog */}
      <Dialog
        open={!!selectedTicket}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTicket(null);
            setTicketDetail(null);
            setReplyText("");
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          {loadingDetail ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : (
            ticketDetail && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    {getStatusIcon(ticketDetail.status)}
                    {ticketDetail.title}
                  </DialogTitle>
                  <DialogDescription>
                    {ticketDetail.id.slice(0, 8).toUpperCase()} • Created{" "}
                    {formatDate(ticketDetail.createdAt)}
                    {ticketDetail.issueType && (
                      <> • {formatIssueType(ticketDetail.issueType)}</>
                    )}
                  </DialogDescription>
                </DialogHeader>

                <div className="flex-1 overflow-y-auto max-h-[60vh] space-y-4 pb-4">
                  {/* User Info */}
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                    <Avatar>
                      <AvatarImage src={ticketDetail.user?.image || ""} />
                      <AvatarFallback>
                        {ticketDetail.user?.name?.charAt(0) || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">
                        {ticketDetail.user?.name || "Unknown"}
                      </p>
                      <p className="text-sm text-zinc-500">
                        {ticketDetail.user?.email}
                      </p>
                    </div>
                  </div>

                  {/* Description */}
                  <div>
                    <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">
                      Description
                    </p>
                    <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                      {ticketDetail.description}
                    </p>
                  </div>

                  {/* Linked Entities */}
                  {(ticketDetail.linkedConsultation ||
                    ticketDetail.linkedPayment) && (
                    <div className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-700">
                      <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">
                        Linked Information
                      </p>
                      {ticketDetail.linkedPayment && (
                        <div className="flex items-center gap-2 text-sm">
                          <CreditCard className="h-4 w-4 text-zinc-400" />
                          <span>
                            Payment:{" "}
                            {formatCurrency(
                              ticketDetail.linkedPayment.amount,
                              ticketDetail.linkedPayment.currency,
                            )}
                          </span>
                          <Badge variant="outline">
                            {ticketDetail.linkedPayment.paymentStatus}
                          </Badge>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Status Update */}
                  <div>
                    <Label className="text-xs text-zinc-500 uppercase tracking-wide">
                      Update Status
                    </Label>
                    <Select
                      value={ticketDetail.status}
                      onValueChange={handleUpdateStatus}
                      disabled={updatingStatus}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="OPEN">Open</SelectItem>
                        <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                        <SelectItem value="ON_HOLD">On Hold</SelectItem>
                        <SelectItem value="RESOLVED">Resolved</SelectItem>
                        <SelectItem value="CLOSED">Closed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  {/* Responses */}
                  <div>
                    <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">
                      Conversation
                    </p>
                    <div className="space-y-3">
                      {ticketDetail.responses?.map((response) => (
                        <div
                          key={response.id}
                          className={`p-3 rounded-lg ${response.isInternal ? "bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800" : "bg-zinc-50 dark:bg-zinc-800"}`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium">
                              {response.user?.name || "Unknown"}
                            </span>
                            {response.isInternal && (
                              <Badge
                                variant="outline"
                                className="text-xs bg-amber-100 text-amber-700 border-amber-300"
                              >
                                Internal
                              </Badge>
                            )}
                            <span className="text-xs text-zinc-400">
                              {formatDate(response.createdAt)}
                            </span>
                          </div>
                          <p className="text-sm text-zinc-700 dark:text-zinc-300">
                            {response.message}
                          </p>
                        </div>
                      ))}
                      {(!ticketDetail.responses ||
                        ticketDetail.responses.length === 0) && (
                        <p className="text-sm text-zinc-400 text-center py-4">
                          No responses yet
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Reply Form */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Reply</Label>
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={isInternalNote}
                          onChange={(e) => setIsInternalNote(e.target.checked)}
                          className="rounded"
                        />
                        Internal note
                      </label>
                    </div>
                    <Textarea
                      placeholder={
                        isInternalNote
                          ? "Add internal note..."
                          : "Type your reply..."
                      }
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                    />
                  </div>
                </div>

                <DialogFooter className="mt-4">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSelectedTicket(null);
                      setTicketDetail(null);
                      setReplyText("");
                    }}
                  >
                    Close
                  </Button>
                  <Button
                    onClick={handleSendReply}
                    disabled={sendingReply || !replyText.trim()}
                  >
                    {sendingReply ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Send className="h-4 w-4 mr-2" />
                    )}
                    {isInternalNote ? "Add Note" : "Send Reply"}
                  </Button>
                </DialogFooter>
              </>
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
