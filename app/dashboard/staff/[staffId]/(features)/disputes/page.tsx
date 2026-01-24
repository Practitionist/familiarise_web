"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Search,
  AlertTriangle,
  RefreshCw,
  Loader2,
  AlertCircle,
  Clock,
  CheckCircle,
  XCircle,
  Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Dispute {
  id: string;
  disputeId: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  dueBy: string | null;
  createdAt: string;
  payment: {
    id: string;
    paymentIntent: string;
  } | null;
}

interface DisputeListResponse {
  disputes: Dispute[];
  total: number;
  urgentDisputes: number;
  page: number;
  limit: number;
  totalPages: number;
}

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "WON":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "LOST":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "UNDER_REVIEW":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toUpperCase()) {
    case "WON":
      return <CheckCircle className="h-3 w-3" />;
    case "LOST":
      return <XCircle className="h-3 w-3" />;
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return <AlertTriangle className="h-3 w-3" />;
    case "UNDER_REVIEW":
      return <Clock className="h-3 w-3" />;
    default:
      return null;
  }
};

const formatCurrency = (amount: number, currency: string = "INR") => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency,
    maximumFractionDigits: 0,
  }).format(amount / 100);
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getDaysUntilDue = (dueBy: string | null) => {
  if (!dueBy) return null;
  const now = new Date();
  const due = new Date(dueBy);
  const diffDays = Math.ceil(
    (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );
  return diffDays;
};

export default function StaffDisputesPage() {
  const { toast } = useToast();
  const router = useRouter();
  const params = useParams();
  const staffId = params.staffId as string;

  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [gatewayFilter, setGatewayFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [urgentCount, setUrgentCount] = useState(0);

  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchDisputes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "20");
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (gatewayFilter !== "all") params.set("gateway", gatewayFilter);

      const response = await fetch(`/api/admin/disputes?${params}`);
      if (!response.ok) throw new Error("Failed to fetch disputes");

      const data: DisputeListResponse = await response.json();
      setDisputes(data.disputes);
      setTotalPages(data.totalPages);
      setTotal(data.total);
      setUrgentCount(data.urgentDisputes);
    } catch (error) {
      console.error("Error fetching disputes:", error);
      toast({
        title: "Error",
        description: "Failed to load disputes",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, statusFilter, gatewayFilter, toast]);

  useEffect(() => {
    fetchDisputes();
  }, [fetchDisputes]);

  const handleViewDispute = (disputeId: string) => {
    router.push(`/dashboard/staff/${staffId}/disputes/${disputeId}`);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Disputes
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            View and track payment disputes
          </p>
        </div>
        <Button variant="outline" onClick={fetchDisputes} disabled={loading}>
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Urgent Disputes Alert */}
      {urgentCount > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Urgent Attention Required</AlertTitle>
          <AlertDescription>
            {urgentCount} dispute{urgentCount > 1 ? "s" : ""} require
            {urgentCount === 1 ? "s" : ""} response within 3 days. Please
            escalate to admin for evidence submission.
          </AlertDescription>
        </Alert>
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950">
              <AlertTriangle className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{total}</p>
              <p className="text-sm text-zinc-500">Total Disputes</p>
            </div>
          </CardContent>
        </Card>
        <Card
          className={
            urgentCount > 0 ? "border-red-200 bg-red-50 dark:bg-red-950/20" : ""
          }
        >
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900">
              <AlertCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-red-600">{urgentCount}</p>
              <p className="text-sm text-zinc-500">Urgent (Due in 3 days)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950">
              <Clock className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {disputes.filter((d) => d.status === "UNDER_REVIEW").length}
              </p>
              <p className="text-sm text-zinc-500">Under Review</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {disputes.filter((d) => d.status === "WON").length}
              </p>
              <p className="text-sm text-zinc-500">Won</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input
                placeholder="Search by dispute ID..."
                className="pl-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="NEEDS_RESPONSE">Needs Response</SelectItem>
                <SelectItem value="WARNING_NEEDS_RESPONSE">
                  Warning - Needs Response
                </SelectItem>
                <SelectItem value="UNDER_REVIEW">Under Review</SelectItem>
                <SelectItem value="WON">Won</SelectItem>
                <SelectItem value="LOST">Lost</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={gatewayFilter}
              onValueChange={(v) => {
                setGatewayFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Gateway" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Gateways</SelectItem>
                <SelectItem value="STRIPE">Stripe</SelectItem>
                <SelectItem value="RAZORPAY">Razorpay</SelectItem>
                <SelectItem value="LEMON_SQUEEZY">Lemon Squeezy</SelectItem>
                <SelectItem value="XFLOW">xFlow</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Disputes Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-600" />
            Disputes ({total})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : disputes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
              <AlertTriangle className="h-12 w-12 mb-4 text-zinc-300" />
              <p>No disputes found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dispute ID</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Gateway</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Due By</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {disputes.map((dispute) => {
                  const daysUntilDue = getDaysUntilDue(dispute.dueBy);
                  const isUrgent =
                    daysUntilDue !== null &&
                    daysUntilDue <= 3 &&
                    daysUntilDue >= 0;

                  return (
                    <TableRow
                      key={dispute.id}
                      className={`cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900 ${isUrgent ? "bg-red-50 dark:bg-red-950/20" : ""}`}
                      onClick={() => handleViewDispute(dispute.id)}
                    >
                      <TableCell>
                        <div>
                          <p className="font-mono text-sm">
                            {dispute.disputeId?.slice(-12) ||
                              dispute.id.slice(-8).toUpperCase()}
                          </p>
                          {dispute.payment && (
                            <p className="text-xs text-zinc-400">
                              Payment:{" "}
                              {dispute.payment.paymentIntent.slice(-12)}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatCurrency(dispute.amount, dispute.currency)}
                      </TableCell>
                      <TableCell className="text-sm text-zinc-600 dark:text-zinc-400">
                        {dispute.paymentGateway}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={`${getStatusColor(dispute.status)} gap-1`}
                          variant="secondary"
                        >
                          {getStatusIcon(dispute.status)}
                          {dispute.status.toLowerCase().replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {dispute.dueBy ? (
                          <div
                            className={
                              isUrgent
                                ? "text-red-600 font-medium"
                                : "text-zinc-500"
                            }
                          >
                            {formatDate(dispute.dueBy)}
                            {daysUntilDue !== null && daysUntilDue >= 0 && (
                              <p className="text-xs">
                                {daysUntilDue === 0
                                  ? "Due today!"
                                  : `${daysUntilDue} days left`}
                              </p>
                            )}
                          </div>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-zinc-500">
                        {formatDate(dispute.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleViewDispute(dispute.id);
                          }}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
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
    </div>
  );
}
