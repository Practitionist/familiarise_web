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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  MessageSquare,
  Clock,
  CheckCircle2,
  AlertCircle,
  MoreHorizontal,
  RefreshCw,
  Star,
  Loader2,
  Eye,
  Mail,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Feedback, FeedbackCounts } from "@/types/feedback";
import { FeedbackStatus } from "@prisma/client";

const STATUS_OPTIONS: { value: FeedbackStatus | "all"; label: string }[] = [
  { value: "all", label: "All Status" },
  { value: "PENDING", label: "Pending" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
];

const getStatusColor = (status: FeedbackStatus) => {
  switch (status) {
    case "PENDING":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "ACKNOWLEDGED":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "IN_PROGRESS":
      return "bg-purple-100 text-purple-700 border-purple-200";
    case "RESOLVED":
      return "bg-green-100 text-green-700 border-green-200";
    case "CLOSED":
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
    default:
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
  }
};

const getStatusIcon = (status: FeedbackStatus) => {
  switch (status) {
    case "PENDING":
      return <AlertCircle className="h-4 w-4 text-amber-500" />;
    case "ACKNOWLEDGED":
      return <Eye className="h-4 w-4 text-blue-500" />;
    case "IN_PROGRESS":
      return <Clock className="h-4 w-4 text-purple-500" />;
    case "RESOLVED":
    case "CLOSED":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
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

export default function StaffFeedbackPage() {
  const { toast } = useToast();
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [counts, setCounts] = useState<FeedbackCounts>({
    total: 0,
    pending: 0,
    acknowledged: 0,
    inProgress: 0,
    resolved: 0,
    closed: 0,
  });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Detail view state
  const [selectedFeedback, setSelectedFeedback] = useState<Feedback | null>(
    null,
  );
  const [updatingStatus, setUpdatingStatus] = useState(false);

  // Fetch feedbacks
  const fetchFeedbacks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
        ...(statusFilter !== "all" && { status: statusFilter }),
        ...(searchQuery && { search: searchQuery }),
      });

      const response = await fetch(`/api/staff/feedbacks?${params}`);
      if (!response.ok) throw new Error("Failed to fetch feedbacks");

      const data = await response.json();
      setFeedbacks(data.feedbacks);
      setCounts(data.counts);
      setTotalPages(data.pagination.totalPages);
    } catch (error) {
      console.error("Error fetching feedbacks:", error);
      toast({
        title: "Error",
        description: "Failed to load feedbacks",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, searchQuery, toast]);

  useEffect(() => {
    fetchFeedbacks();
  }, [fetchFeedbacks]);

  // Update feedback status
  const handleUpdateStatus = async (
    feedbackId: string,
    newStatus: FeedbackStatus,
  ) => {
    setUpdatingStatus(true);
    try {
      const response = await fetch(`/api/staff/feedbacks/${feedbackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!response.ok) throw new Error("Failed to update status");

      toast({ title: "Success", description: "Status updated successfully" });
      fetchFeedbacks();
      if (selectedFeedback?.id === feedbackId) {
        setSelectedFeedback({ ...selectedFeedback, status: newStatus });
      }
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            User Feedback
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            View and manage feedback submitted by users
          </p>
        </div>
        <Button onClick={fetchFeedbacks} variant="outline" size="sm">
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide">
                  Pending
                </p>
                <p className="text-2xl font-bold text-amber-600">
                  {counts.pending}
                </p>
              </div>
              <AlertCircle className="h-8 w-8 text-amber-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide">
                  Acknowledged
                </p>
                <p className="text-2xl font-bold text-blue-600">
                  {counts.acknowledged}
                </p>
              </div>
              <Eye className="h-8 w-8 text-blue-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide">
                  In Progress
                </p>
                <p className="text-2xl font-bold text-purple-600">
                  {counts.inProgress}
                </p>
              </div>
              <Clock className="h-8 w-8 text-purple-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide">
                  Resolved
                </p>
                <p className="text-2xl font-bold text-green-600">
                  {counts.resolved}
                </p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-green-200" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide">
                  Total
                </p>
                <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                  {counts.total}
                </p>
              </div>
              <MessageSquare className="h-8 w-8 text-zinc-200" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input
                placeholder="Search by title, description, or user..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Feedback Table */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : feedbacks.length === 0 ? (
            <div className="text-center py-12">
              <MessageSquare className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
              <p className="text-zinc-500">No feedback found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feedbacks.map((feedback) => (
                  <TableRow
                    key={feedback.id}
                    className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                    onClick={() => setSelectedFeedback(feedback)}
                  >
                    <TableCell className="font-mono text-xs text-zinc-500">
                      {feedback.id.slice(0, 8).toUpperCase()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {getStatusIcon(feedback.status)}
                        <span className="font-medium truncate max-w-[200px]">
                          {feedback.title}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-7 w-7">
                          <AvatarImage src={feedback.user.image || ""} />
                          <AvatarFallback className="text-xs">
                            {feedback.user.name?.charAt(0) || "U"}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm">
                          {feedback.user.name || "Unknown"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {feedback.rating ? (
                        <div className="flex items-center gap-1">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star
                              key={i}
                              className={`h-3.5 w-3.5 ${
                                i < feedback.rating!
                                  ? "text-amber-500 fill-amber-500"
                                  : "text-zinc-300"
                              }`}
                            />
                          ))}
                        </div>
                      ) : (
                        <span className="text-zinc-400 text-sm">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={getStatusColor(feedback.status)}
                      >
                        {feedback.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-zinc-500 text-sm">
                      {formatDate(feedback.createdAt)}
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
                              setSelectedFeedback(feedback);
                            }}
                          >
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUpdateStatus(feedback.id, "ACKNOWLEDGED");
                            }}
                          >
                            Mark Acknowledged
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUpdateStatus(feedback.id, "RESOLVED");
                            }}
                          >
                            Mark Resolved
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUpdateStatus(feedback.id, "CLOSED");
                            }}
                          >
                            Close
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

      {/* Detail Dialog */}
      <Dialog
        open={!!selectedFeedback}
        onOpenChange={(open) => !open && setSelectedFeedback(null)}
      >
        <DialogContent className="max-w-lg">
          {selectedFeedback && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {getStatusIcon(selectedFeedback.status)}
                  {selectedFeedback.title}
                </DialogTitle>
                <DialogDescription>
                  Submitted {formatDate(selectedFeedback.createdAt)}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* User Info */}
                <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                  <Avatar>
                    <AvatarImage src={selectedFeedback.user.image || ""} />
                    <AvatarFallback>
                      {selectedFeedback.user.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <p className="font-medium">
                      {selectedFeedback.user.name || "Unknown"}
                    </p>
                    <div className="flex items-center gap-3 text-sm text-zinc-500">
                      {selectedFeedback.user.email && (
                        <span className="flex items-center gap-1">
                          <Mail className="h-3 w-3" />
                          {selectedFeedback.user.email}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Rating */}
                {selectedFeedback.rating && (
                  <div>
                    <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">
                      Rating
                    </p>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-5 w-5 ${
                            i < selectedFeedback.rating!
                              ? "text-amber-500 fill-amber-500"
                              : "text-zinc-300"
                          }`}
                        />
                      ))}
                      <span className="ml-2 text-sm text-zinc-600">
                        {selectedFeedback.rating} / 5
                      </span>
                    </div>
                  </div>
                )}

                {/* Description */}
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">
                    Description
                  </p>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                    {selectedFeedback.description}
                  </p>
                </div>

                {/* Status Update */}
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">
                    Update Status
                  </p>
                  <Select
                    value={selectedFeedback.status}
                    onValueChange={(value) =>
                      handleUpdateStatus(
                        selectedFeedback.id,
                        value as FeedbackStatus,
                      )
                    }
                    disabled={updatingStatus}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">Pending</SelectItem>
                      <SelectItem value="ACKNOWLEDGED">Acknowledged</SelectItem>
                      <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                      <SelectItem value="RESOLVED">Resolved</SelectItem>
                      <SelectItem value="CLOSED">Closed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
