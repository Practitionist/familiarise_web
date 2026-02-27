"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatCurrencyAmount } from "@/utils/formatting";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  CreditCard,
  IndianRupee,
  XCircle,
  RefreshCw,
  ArrowUpRight,
  MoreHorizontal,
  Receipt,
  FileText,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import type {
  Payment,
  Refund,
  PaymentListResponse,
  RefundListResponse,
} from "@/types/payments";

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "SUCCEEDED":
    case "COMPLETED":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "PENDING":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "FAILED":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "APPROVED":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getTypeColor = (type: string) => {
  switch (type?.toUpperCase()) {
    case "CONSULTATION":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "SUBSCRIPTION":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    case "WEBINAR":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "CLASS":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
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

export default function PaymentsAssistancePage() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("payments");

  // Payments state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);

  // Refunds state

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch payments with React Query
  const {
    data: paymentsData,
    isLoading: loadingPayments,
    refetch: refetchPayments,
  } = useQuery({
    queryKey: ["staff-payments", page, debouncedSearch, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const response = await fetch(`/api/admin/payments?${params}`);
      if (!response.ok) throw new Error("Failed to fetch payments");
      return response.json() as Promise<PaymentListResponse>;
    },
  });
  const payments = paymentsData?.payments ?? [];
  const totalPages = paymentsData?.totalPages ?? 1;

  // Fetch refunds with React Query
  const {
    data: refundsData,
    isLoading: loadingRefunds,
    refetch: refetchRefunds,
  } = useQuery({
    queryKey: ["staff-refunds-pending"],
    queryFn: async () => {
      const response = await fetch("/api/admin/refunds?status=PENDING");
      if (!response.ok) throw new Error("Failed to fetch refunds");
      return response.json() as Promise<RefundListResponse>;
    },
    enabled: activeTab === "refunds",
  });
  const refunds = refundsData?.refunds ?? [];

  // Calculate stats
  const stats = {
    totalTransactions: payments.length,
    totalAmount: payments
      .filter((p) => p.paymentStatus === "SUCCEEDED")
      .reduce((sum, p) => sum + p.amount, 0),
    pendingRefunds: refunds.filter((r) => r.status === "PENDING").length,
    failedPayments: payments.filter((p) => p.paymentStatus === "FAILED").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Payments Assistance
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            View payment issues and process refund requests
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            refetchPayments();
            if (activeTab === "refunds") refetchRefunds();
          }}
          disabled={loadingPayments || loadingRefunds}
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loadingPayments || loadingRefunds ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950">
              <CreditCard className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.totalTransactions}</p>
              <p className="text-sm text-zinc-500">Transactions (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950">
              <IndianRupee className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {formatCurrencyAmount(stats.totalAmount, "INR")}
              </p>
              <p className="text-sm text-zinc-500">Processed (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-purple-50 dark:bg-purple-950">
              <RefreshCw className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.pendingRefunds}</p>
              <p className="text-sm text-zinc-500">Pending Refunds</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.failedPayments}</p>
              <p className="text-sm text-zinc-500">Failed (page)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="payments">All Payments</TabsTrigger>
          <TabsTrigger value="refunds" className="gap-2">
            Refund Requests
            {stats.pendingRefunds > 0 && (
              <Badge variant="secondary" className="ml-1">
                {stats.pendingRefunds}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* All Payments Tab */}
        <TabsContent value="payments" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <Input
                    placeholder="Search by payment ID..."
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
                    <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {loadingPayments ? (
                <div className="flex items-center justify-center h-64">
                  <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
                </div>
              ) : payments.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
                  <CreditCard className="h-12 w-12 mb-4 text-zinc-300" />
                  <p>No payments found</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Payment ID</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Gateway</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((payment) => (
                      <TableRow
                        key={payment.id}
                        className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                        onClick={() => setSelectedPayment(payment)}
                      >
                        <TableCell>
                          <div>
                            <p className="font-mono text-sm">
                              {payment.id.slice(-8).toUpperCase()}
                            </p>
                            <p className="text-xs text-zinc-400">
                              {payment.paymentIntent.slice(-12)}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">
                          {formatCurrencyAmount(
                            payment.amount,
                            payment.currency,
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={getTypeColor(
                              payment.appointment?.appointmentType || "",
                            )}
                            variant="secondary"
                          >
                            {payment.appointment?.appointmentType?.toLowerCase() ||
                              "N/A"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-zinc-600 dark:text-zinc-400">
                          {payment.paymentGateway}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={getStatusColor(payment.paymentStatus)}
                            variant="secondary"
                          >
                            {payment.paymentStatus.toLowerCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-zinc-500">
                          {formatDate(payment.createdAt)}
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
                              <DropdownMenuItem>
                                <Receipt className="h-4 w-4 mr-2" />
                                View Receipt
                              </DropdownMenuItem>
                              <DropdownMenuItem>
                                <FileText className="h-4 w-4 mr-2" />
                                Download Invoice
                              </DropdownMenuItem>
                              {payment.paymentStatus === "FAILED" && (
                                <DropdownMenuItem>
                                  <RefreshCw className="h-4 w-4 mr-2" />
                                  Retry Payment
                                </DropdownMenuItem>
                              )}
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
        </TabsContent>

        {/* Refunds Tab */}
        <TabsContent value="refunds" className="space-y-4">
          {loadingRefunds ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : refunds.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center h-64 text-zinc-500">
                <RefreshCw className="h-12 w-12 mb-4 text-zinc-300" />
                <p>No pending refund requests</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {refunds.map((refund) => (
                <Card
                  key={refund.id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <Avatar>
                          <AvatarFallback>RF</AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium">
                              Refund {refund.id.slice(-8).toUpperCase()}
                            </p>
                            <Badge
                              className={getStatusColor(refund.status)}
                              variant="secondary"
                            >
                              {refund.status.toLowerCase()}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
                            <span>
                              Payment:{" "}
                              {refund.payment?.paymentIntent.slice(-12)}
                            </span>
                            <span>
                              Amount:{" "}
                              {formatCurrencyAmount(
                                refund.amount,
                                refund.currency,
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                      <span className="text-xs text-zinc-400">
                        {formatDate(refund.createdAt)}
                      </span>
                    </div>
                    {refund.status === "PENDING" && (
                      <div className="flex justify-end gap-2 mt-4">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600"
                        >
                          <XCircle className="h-4 w-4 mr-1" />
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <CheckCircle2 className="h-4 w-4 mr-1" />
                          Approve Refund
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Payment Detail Dialog */}
      <Dialog
        open={!!selectedPayment}
        onOpenChange={() => setSelectedPayment(null)}
      >
        <DialogContent className="max-w-lg">
          {selectedPayment && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5" />
                  Payment Details
                </DialogTitle>
                <DialogDescription>
                  {selectedPayment.id.slice(-8).toUpperCase()} •{" "}
                  {selectedPayment.paymentIntent.slice(-12)}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                  <div>
                    <p className="text-sm text-zinc-500">Amount</p>
                    <p className="text-2xl font-bold">
                      {formatCurrencyAmount(
                        selectedPayment.amount,
                        selectedPayment.currency,
                      )}
                    </p>
                  </div>
                  <Badge
                    className={getStatusColor(selectedPayment.paymentStatus)}
                    variant="secondary"
                  >
                    {selectedPayment.paymentStatus.toLowerCase()}
                  </Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-zinc-500">Type</Label>
                    <p className="capitalize">
                      {selectedPayment.appointment?.appointmentType?.toLowerCase() ||
                        "N/A"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">
                      Payment Gateway
                    </Label>
                    <p>{selectedPayment.paymentGateway}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">Date</Label>
                    <p>{formatDate(selectedPayment.createdAt)}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">
                      Payment Method
                    </Label>
                    <p>{selectedPayment.paymentMethod || "N/A"}</p>
                  </div>
                </div>
                {selectedPayment.description && (
                  <div>
                    <Label className="text-xs text-zinc-500">Description</Label>
                    <p className="text-sm">{selectedPayment.description}</p>
                  </div>
                )}
                <div>
                  <Label htmlFor="note">Staff Note</Label>
                  <Textarea
                    id="note"
                    placeholder="Add a note about this payment..."
                    className="mt-1"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setSelectedPayment(null)}
                >
                  Close
                </Button>
                <Button variant="outline">
                  <ArrowUpRight className="h-4 w-4 mr-2" />
                  Escalate to Admin
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
