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
  Paperclip,
  Send,
  FileText,
  Loader2,
  CreditCard,
  ExternalLink,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import type { Ticket, TicketCounts, TicketListResponse } from "@/types/tickets";

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "OPEN":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "IN_PROGRESS":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "ON_HOLD":
      return "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300";
    case "RESOLVED":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "CLOSED":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getPriorityColor = (priority: string) => {
  switch (priority.toUpperCase()) {
    case "URGENT":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "HIGH":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "MEDIUM":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    case "LOW":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
    default:
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
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

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function SupportTicketsPage() {
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
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Detail view state
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [ticketDetail, setTicketDetail] = useState<Ticket | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [initiatingRefund, setInitiatingRefund] = useState(false);

  // Fetch tickets
  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "20");
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (priorityFilter !== "all") params.set("priority", priorityFilter);
      if (searchQuery) params.set("search", searchQuery);

      const response = await fetch(`/api/staff/support-tickets?${params}`);
      if (!response.ok) throw new Error("Failed to fetch tickets");

      const data: TicketListResponse = await response.json();
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
  }, [page, statusFilter, priorityFilter, searchQuery, toast]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  // Fetch ticket detail
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

  // Handle ticket selection
  const handleSelectTicket = async (ticket: Ticket) => {
    setSelectedTicket(ticket);
    await fetchTicketDetail(ticket.id);
  };

  // Update ticket status
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

  // Send reply
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

  // Initiate refund
  const handleInitiateRefund = async () => {
    if (!ticketDetail?.linkedPayment) return;
    setInitiatingRefund(true);
    try {
      const response = await fetch("/api/payments/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: ticketDetail.linkedPayment.id,
          reason: `Refund initiated from support ticket ${ticketDetail.id}`,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to initiate refund");
      }

      const refund = await response.json();

      // Update ticket with refund ID
      await fetch(`/api/staff/support-tickets/${ticketDetail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refundId: refund.id }),
      });

      toast({ title: "Success", description: "Refund initiated successfully" });
      fetchTicketDetail(ticketDetail.id);
    } catch (error) {
      console.error("Error initiating refund:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to initiate refund",
        variant: "destructive",
      });
    } finally {
      setInitiatingRefund(false);
    }
  };

  // Quick actions
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
          <p className="text-zinc-500 dark:text-zinc-400">
            Manage and respond to user support requests
          </p>
        </div>
        <Button variant="outline" onClick={fetchTickets} disabled={loading}>
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-5">
        {[
          { label: "All", value: counts.total, color: "text-zinc-600" },
          { label: "Open", value: counts.open, color: "text-blue-600" },
          {
            label: "In Progress",
            value: counts.inProgress,
            color: "text-yellow-600",
          },
          {
            label: "On Hold",
            value: counts.onHold,
            color: "text-orange-600",
          },
          {
            label: "Resolved",
            value: counts.resolved,
            color: "text-green-600",
          },
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
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
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
            <Select
              value={priorityFilter}
              onValueChange={(v) => {
                setPriorityFilter(v);
                setPage(1);
              }}
            >
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
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : tickets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
              <MessageSquare className="h-12 w-12 mb-4" />
              <p>No support tickets found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Ticket ID</TableHead>
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
                    className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    onClick={() => handleSelectTicket(ticket)}
                  >
                    <TableCell className="font-mono text-xs">
                      {ticket.id.slice(-8).toUpperCase()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {getStatusIcon(ticket.status)}
                        <span className="font-medium truncate max-w-[200px]">
                          {ticket.title}
                        </span>
                        {(ticket.responseCount ?? 0) > 0 && (
                          <Badge variant="outline" className="text-xs gap-1">
                            <MessageSquare className="h-3 w-3" />
                            {ticket.responseCount}
                          </Badge>
                        )}
                        {(ticket.attachmentCount ?? 0) > 0 && (
                          <Badge variant="outline" className="text-xs gap-1">
                            <Paperclip className="h-3 w-3" />
                            {ticket.attachmentCount}
                          </Badge>
                        )}
                        {ticket.paymentId && (
                          <Badge variant="outline" className="text-xs gap-1">
                            <CreditCard className="h-3 w-3" />
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-6 w-6">
                          <AvatarImage src={ticket.user.image || ""} />
                          <AvatarFallback className="text-xs">
                            {ticket.user.name
                              ?.split(" ")
                              .map((n) => n[0])
                              .join("") || "?"}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm">
                          {ticket.user.name || "Unknown"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={getStatusColor(ticket.status)}
                        variant="secondary"
                      >
                        {ticket.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={getPriorityColor(ticket.priority)}
                        variant="secondary"
                      >
                        {ticket.priority}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-zinc-600 dark:text-zinc-400">
                      {ticket.issueType?.replace(/_/g, " ") ||
                        ticket.category ||
                        "-"}
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
                            onClick={(e) =>
                              handleQuickAction(ticket.id, "resolve", e)
                            }
                          >
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                            Mark Resolved
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-red-600"
                            onClick={(e) =>
                              handleQuickAction(ticket.id, "close", e)
                            }
                          >
                            <XCircle className="h-4 w-4 mr-2" />
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
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="flex items-center px-4 text-sm text-zinc-500">
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

      {/* Ticket Detail Dialog */}
      <Dialog
        open={!!selectedTicket}
        onOpenChange={() => {
          setSelectedTicket(null);
          setTicketDetail(null);
          setReplyText("");
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
          {loadingDetail ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : ticketDetail ? (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between">
                  <DialogTitle className="flex items-center gap-2">
                    {getStatusIcon(ticketDetail.status)}
                    <span className="truncate max-w-[400px]">
                      {ticketDetail.title}
                    </span>
                  </DialogTitle>
                  <div className="flex gap-2">
                    <Badge
                      className={getPriorityColor(ticketDetail.priority)}
                      variant="secondary"
                    >
                      {ticketDetail.priority}
                    </Badge>
                    <Badge
                      className={getStatusColor(ticketDetail.status)}
                      variant="secondary"
                    >
                      {ticketDetail.status.replace("_", " ")}
                    </Badge>
                  </div>
                </div>
                <DialogDescription>
                  {ticketDetail.id.slice(-8).toUpperCase()} • Created{" "}
                  {formatDate(ticketDetail.createdAt)}
                  {ticketDetail.issueType && (
                    <> • {ticketDetail.issueType.replace(/_/g, " ")}</>
                  )}
                </DialogDescription>
              </DialogHeader>

              <div className="flex-1 -mx-6 px-6 overflow-y-auto max-h-[60vh]">
                <div className="space-y-4 pb-4">
                  {/* User Info */}
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                    <Avatar>
                      <AvatarImage src={ticketDetail.user.image || ""} />
                      <AvatarFallback>
                        {ticketDetail.user.name
                          ?.split(" ")
                          .map((n) => n[0])
                          .join("") || "?"}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">
                        {ticketDetail.user.name || "Unknown"}
                      </p>
                      <p className="text-sm text-zinc-500">
                        {ticketDetail.user.email}
                        {ticketDetail.user.phone &&
                          ` • ${ticketDetail.user.phone}`}
                      </p>
                    </div>
                  </div>

                  {/* Linked Booking Context */}
                  {ticketDetail.linkedConsultation && (
                    <div className="p-3 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950">
                      <div className="flex items-center gap-2 mb-2">
                        <Calendar className="h-4 w-4 text-blue-600" />
                        <span className="font-medium text-blue-900 dark:text-blue-100">
                          Linked Booking
                        </span>
                      </div>
                      <div className="text-sm space-y-1">
                        <p>
                          <strong>Plan:</strong>{" "}
                          {
                            ticketDetail.linkedConsultation.consultationPlan
                              .title
                          }
                        </p>
                        <p>
                          <strong>Consultant:</strong>{" "}
                          {
                            ticketDetail.linkedConsultation.consultationPlan
                              .consultantProfile.user.name
                          }
                        </p>
                        <p>
                          <strong>Status:</strong>{" "}
                          {ticketDetail.linkedConsultation.requestStatus}
                        </p>
                        {ticketDetail.linkedConsultation.appointment && (
                          <p>
                            <strong>Scheduled:</strong>{" "}
                            {new Date(
                              ticketDetail.linkedConsultation.appointment
                                .scheduledAt,
                            ).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Linked Payment Context */}
                  {ticketDetail.linkedPayment && (
                    <div className="p-3 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <DollarSign className="h-4 w-4 text-green-600" />
                          <span className="font-medium text-green-900 dark:text-green-100">
                            Linked Payment
                          </span>
                        </div>
                        {ticketDetail.linkedPayment.paymentStatus ===
                          "SUCCEEDED" &&
                          !ticketDetail.linkedRefund && (
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={handleInitiateRefund}
                              disabled={initiatingRefund}
                            >
                              {initiatingRefund ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              ) : (
                                <DollarSign className="h-4 w-4 mr-2" />
                              )}
                              Initiate Refund
                            </Button>
                          )}
                      </div>
                      <div className="text-sm space-y-1">
                        <p>
                          <strong>Amount:</strong>{" "}
                          {formatCurrency(
                            ticketDetail.linkedPayment.amount,
                            ticketDetail.linkedPayment.currency,
                          )}
                        </p>
                        <div>
                          <strong>Status:</strong>{" "}
                          <Badge
                            variant="outline"
                            className={
                              ticketDetail.linkedPayment.paymentStatus ===
                              "SUCCEEDED"
                                ? "text-green-600"
                                : "text-yellow-600"
                            }
                          >
                            {ticketDetail.linkedPayment.paymentStatus}
                          </Badge>
                        </div>
                        <p>
                          <strong>Gateway:</strong>{" "}
                          {ticketDetail.linkedPayment.paymentGateway}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Linked Refund */}
                  {ticketDetail.linkedRefund && (
                    <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
                      <div className="flex items-center gap-2 mb-2">
                        <DollarSign className="h-4 w-4 text-amber-600" />
                        <span className="font-medium text-amber-900 dark:text-amber-100">
                          Refund Initiated
                        </span>
                      </div>
                      <div className="text-sm space-y-1">
                        <p>
                          <strong>Amount:</strong>{" "}
                          {formatCurrency(
                            ticketDetail.linkedRefund.amount,
                            ticketDetail.linkedRefund.currency,
                          )}
                        </p>
                        <div>
                          <strong>Status:</strong>{" "}
                          <Badge
                            variant="outline"
                            className={
                              ticketDetail.linkedRefund.status === "SUCCEEDED"
                                ? "text-green-600"
                                : "text-yellow-600"
                            }
                          >
                            {ticketDetail.linkedRefund.status}
                          </Badge>
                        </div>
                        {ticketDetail.linkedRefund.reason && (
                          <p>
                            <strong>Reason:</strong>{" "}
                            {ticketDetail.linkedRefund.reason}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Description */}
                  <div>
                    <Label className="text-sm font-medium">Description</Label>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
                      {ticketDetail.description}
                    </p>
                  </div>

                  {/* Attachments */}
                  {ticketDetail.attachments &&
                    ticketDetail.attachments.length > 0 && (
                      <div>
                        <Label className="text-sm font-medium">
                          Attachments
                        </Label>
                        <div className="mt-2 space-y-2">
                          {ticketDetail.attachments.map((attachment) => (
                            <a
                              key={attachment.id}
                              href={attachment.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-2 p-2 border rounded hover:bg-zinc-50 dark:hover:bg-zinc-900"
                            >
                              <FileText className="h-4 w-4 text-zinc-500" />
                              <span className="flex-1 text-sm truncate">
                                {attachment.originalName}
                              </span>
                              <span className="text-xs text-zinc-400">
                                {formatFileSize(attachment.fileSize)}
                              </span>
                              <ExternalLink className="h-3 w-3 text-zinc-400" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                  <Separator />

                  {/* Status Update */}
                  <div className="flex gap-2">
                    <Select
                      value={ticketDetail.status}
                      onValueChange={handleUpdateStatus}
                      disabled={updatingStatus}
                    >
                      <SelectTrigger className="w-40">
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
                    {updatingStatus && (
                      <Loader2 className="h-4 w-4 animate-spin self-center" />
                    )}
                  </div>

                  <Separator />

                  {/* Response Thread */}
                  {ticketDetail.responses &&
                    ticketDetail.responses.length > 0 && (
                      <div>
                        <Label className="text-sm font-medium mb-2 block">
                          Conversation ({ticketDetail.responses.length})
                        </Label>
                        <div className="space-y-3 max-h-[200px] overflow-y-auto">
                          {ticketDetail.responses.map((response) => (
                            <div
                              key={response.id}
                              className={`p-3 rounded-lg ${
                                response.user?.role === "STAFF" ||
                                response.user?.role === "ADMIN"
                                  ? response.isInternal
                                    ? "bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800"
                                    : "bg-blue-50 dark:bg-blue-950"
                                  : "bg-zinc-100 dark:bg-zinc-800"
                              }`}
                            >
                              <div className="flex items-center gap-2 mb-1">
                                <Avatar className="h-5 w-5">
                                  <AvatarImage
                                    src={response.user?.image || ""}
                                  />
                                  <AvatarFallback className="text-xs">
                                    {response.user?.name?.[0] || "?"}
                                  </AvatarFallback>
                                </Avatar>
                                <span className="text-sm font-medium">
                                  {response.user?.name}
                                </span>
                                {response.user?.role && (
                                  <Badge variant="outline" className="text-xs">
                                    {response.user.role}
                                  </Badge>
                                )}
                                {response.isInternal && (
                                  <Badge
                                    variant="outline"
                                    className="text-xs text-amber-600"
                                  >
                                    Internal
                                  </Badge>
                                )}
                                <span className="text-xs text-zinc-400 ml-auto">
                                  {formatDate(response.createdAt)}
                                </span>
                              </div>
                              <p className="text-sm whitespace-pre-wrap">
                                {response.message}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                  {/* Reply Box */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <Label htmlFor="reply">Reply to User</Label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={isInternalNote}
                          onChange={(e) => setIsInternalNote(e.target.checked)}
                          className="rounded"
                        />
                        Internal note (not visible to user)
                      </label>
                    </div>
                    <Textarea
                      id="reply"
                      placeholder={
                        isInternalNote
                          ? "Add an internal note..."
                          : "Type your response to the user..."
                      }
                      rows={3}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                    />
                  </div>
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
                  disabled={!replyText.trim() || sendingReply}
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
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
