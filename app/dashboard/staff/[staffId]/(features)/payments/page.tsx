"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatCurrencyFromMajorUnit } from "@/utils/formatting";
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
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
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
      return "bg-muted text-muted-foreground";
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

export default function PaymentsAssistancePage() {
  const { toast: _toast } = useToast();
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

  const renderPaymentActions = (payment: Payment) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon" className="h-8 w-8">
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
  );

  const paymentColumns: ResponsiveColumn<Payment>[] = [
    {
      key: "id",
      header: "Payment ID",
      primary: true,
      cell: (payment) => (
        <div>
          <p className="font-mono text-sm">
            {payment.id.slice(-8).toUpperCase()}
          </p>
          <p className="text-xs text-muted-foreground/70">
            {payment.paymentIntent.slice(-12)}
          </p>
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      className: "font-medium",
      cell: (payment) =>
        formatCurrencyFromMajorUnit(payment.amount, payment.currency),
    },
    {
      key: "type",
      header: "Type",
      cell: (payment) => (
        <Badge
          className={getTypeColor(payment.appointment?.appointmentType || "")}
          variant="secondary"
        >
          {payment.appointment?.appointmentType?.toLowerCase() || "N/A"}
        </Badge>
      ),
    },
    {
      key: "gateway",
      header: "Gateway",
      className: "text-sm text-muted-foreground",
      cell: (payment) => payment.paymentGateway,
    },
    {
      key: "status",
      header: "Status",
      cell: (payment) => (
        <Badge
          className={getStatusColor(payment.paymentStatus)}
          variant="secondary"
        >
          {payment.paymentStatus.toLowerCase()}
        </Badge>
      ),
    },
    {
      key: "date",
      header: "Date",
      className: "text-sm text-muted-foreground",
      cell: (payment) => formatDate(payment.createdAt),
    },
  ];

  const paymentsEmpty = (
    <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
      <CreditCard className="h-12 w-12 mb-4 text-muted-foreground/40" />
      <p>No payments found</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Payments Assistance"
        subtitle="View payment issues and process refund requests"
        actions={
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
        }
      />

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <CreditCard className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.totalTransactions}</p>
              <p className="text-sm text-muted-foreground">Transactions (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <IndianRupee className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {formatCurrencyFromMajorUnit(stats.totalAmount, "INR")}
              </p>
              <p className="text-sm text-muted-foreground">Processed (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <RefreshCw className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.pendingRefunds}</p>
              <p className="text-sm text-muted-foreground">Pending Refunds</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <XCircle className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.failedPayments}</p>
              <p className="text-sm text-muted-foreground">Failed (page)</p>
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
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <ResponsiveTable<Payment>
                  columns={paymentColumns}
                  rows={payments}
                  getRowId={(p) => p.id}
                  onRowClick={setSelectedPayment}
                  rowActions={renderPaymentActions}
                  empty={paymentsEmpty}
                />
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
        </TabsContent>

        {/* Refunds Tab */}
        <TabsContent value="refunds" className="space-y-4">
          {loadingRefunds ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : refunds.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                <RefreshCw className="h-12 w-12 mb-4 text-muted-foreground/40" />
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
                          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                            <span>
                              Payment:{" "}
                              {refund.payment?.paymentIntent.slice(-12)}
                            </span>
                            <span>
                              Amount:{" "}
                              {formatCurrencyFromMajorUnit(
                                refund.amount,
                                refund.currency,
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
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
      <ResponsiveModal
        open={!!selectedPayment}
        onOpenChange={() => setSelectedPayment(null)}
      >
        <ResponsiveModalContent className="max-w-lg">
          {selectedPayment && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5" />
                  Payment Details
                </ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  {selectedPayment.id.slice(-8).toUpperCase()} •{" "}
                  {selectedPayment.paymentIntent.slice(-12)}
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-muted">
                  <div>
                    <p className="text-sm text-muted-foreground">Amount</p>
                    <p className="text-2xl font-bold">
                      {formatCurrencyFromMajorUnit(
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
                    <Label className="text-xs text-muted-foreground">Type</Label>
                    <p className="capitalize">
                      {selectedPayment.appointment?.appointmentType?.toLowerCase() ||
                        "N/A"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Payment Gateway
                    </Label>
                    <p>{selectedPayment.paymentGateway}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Date</Label>
                    <p>{formatDate(selectedPayment.createdAt)}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Payment Method
                    </Label>
                    <p>{selectedPayment.paymentMethod || "N/A"}</p>
                  </div>
                </div>
                {selectedPayment.description && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Description</Label>
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
              <ResponsiveModalFooter>
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
              </ResponsiveModalFooter>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
