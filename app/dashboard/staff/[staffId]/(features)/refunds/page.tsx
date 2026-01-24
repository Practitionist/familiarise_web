"use client";

import { useState, useEffect, useCallback } from "react";
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
import {
  Search,
  RotateCcw,
  RefreshCw,
  Loader2,
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
  Ban,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Refund {
  id: string;
  refundId: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  createdAt: string;
  payment: {
    id: string;
    paymentIntent: string;
  } | null;
}

interface RefundListResponse {
  refunds: Refund[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "SUCCEEDED":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "PENDING":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "FAILED":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "CANCELLED":
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toUpperCase()) {
    case "SUCCEEDED":
      return <CheckCircle className="h-3 w-3" />;
    case "PENDING":
      return <Clock className="h-3 w-3" />;
    case "FAILED":
      return <XCircle className="h-3 w-3" />;
    case "CANCELLED":
      return <Ban className="h-3 w-3" />;
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

export default function StaffRefundsPage() {
  const { toast } = useToast();
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [gatewayFilter, setGatewayFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchRefunds = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "20");
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (gatewayFilter !== "all") params.set("gateway", gatewayFilter);

      const response = await fetch(`/api/admin/refunds?${params}`);
      if (!response.ok) throw new Error("Failed to fetch refunds");

      const data: RefundListResponse = await response.json();
      setRefunds(data.refunds);
      setTotalPages(data.totalPages);
      setTotal(data.total);
    } catch (error) {
      console.error("Error fetching refunds:", error);
      toast({
        title: "Error",
        description: "Failed to load refunds",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, statusFilter, gatewayFilter, toast]);

  useEffect(() => {
    fetchRefunds();
  }, [fetchRefunds]);

  // Calculate stats
  const stats = {
    total: total,
    pending: refunds.filter((r) => r.status === "PENDING").length,
    succeeded: refunds.filter((r) => r.status === "SUCCEEDED").length,
    failed: refunds.filter((r) => r.status === "FAILED").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Refunds
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            View and track refund requests
          </p>
        </div>
        <Button variant="outline" onClick={fetchRefunds} disabled={loading}>
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950">
              <RotateCcw className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.total}</p>
              <p className="text-sm text-zinc-500">Total Refunds</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950">
              <Clock className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.pending}</p>
              <p className="text-sm text-zinc-500">Pending</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.succeeded}</p>
              <p className="text-sm text-zinc-500">Succeeded</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.failed}</p>
              <p className="text-sm text-zinc-500">Failed</p>
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
                placeholder="Search by refund ID..."
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
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
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

      {/* Refunds Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-blue-600" />
            Refunds ({total})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : refunds.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
              <RotateCcw className="h-12 w-12 mb-4 text-zinc-300" />
              <p>No refunds found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Refund ID</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Gateway</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refunds.map((refund) => (
                  <TableRow key={refund.id}>
                    <TableCell>
                      <div>
                        <p className="font-mono text-sm">
                          {refund.refundId?.slice(-12) ||
                            refund.id.slice(-8).toUpperCase()}
                        </p>
                        {refund.payment && (
                          <p className="text-xs text-zinc-400">
                            Payment: {refund.payment.paymentIntent.slice(-12)}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatCurrency(refund.amount, refund.currency)}
                    </TableCell>
                    <TableCell className="text-sm text-zinc-600 dark:text-zinc-400">
                      {refund.paymentGateway}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={`${getStatusColor(refund.status)} gap-1`}
                        variant="secondary"
                      >
                        {getStatusIcon(refund.status)}
                        {refund.status.toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-zinc-500 max-w-[200px] truncate">
                      {refund.reason || "-"}
                    </TableCell>
                    <TableCell className="text-sm text-zinc-500">
                      {formatDate(refund.createdAt)}
                    </TableCell>
                    <TableCell>
                      {refund.payment && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          asChild
                        >
                          <a
                            href={`/dashboard/admin/payments/${refund.payment.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </Button>
                      )}
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
    </div>
  );
}
