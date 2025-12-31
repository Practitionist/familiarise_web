"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  CreditCard,
  IndianRupee,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  ArrowUpRight,
  MoreHorizontal,
  Receipt,
  FileText,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Mock data
const payments = [
  {
    id: "PAY-001",
    transactionId: "TXN_123456789",
    user: { name: "John Doe", email: "john@example.com" },
    amount: 2500,
    type: "consultation",
    status: "completed",
    paymentMethod: "UPI",
    createdAt: "2025-12-20T10:30:00",
  },
  {
    id: "PAY-002",
    transactionId: "TXN_123456790",
    user: { name: "Jane Smith", email: "jane@example.com" },
    amount: 5000,
    type: "subscription",
    status: "failed",
    paymentMethod: "Card",
    createdAt: "2025-12-20T09:15:00",
    failureReason: "Insufficient funds",
  },
  {
    id: "PAY-003",
    transactionId: "TXN_123456791",
    user: { name: "Mike Wilson", email: "mike@example.com" },
    amount: 1500,
    type: "webinar",
    status: "pending",
    paymentMethod: "UPI",
    createdAt: "2025-12-20T08:00:00",
  },
  {
    id: "PAY-004",
    transactionId: "TXN_123456792",
    user: { name: "Sarah Connor", email: "sarah@example.com" },
    amount: 3500,
    type: "class",
    status: "refund_requested",
    paymentMethod: "Card",
    createdAt: "2025-12-19T14:00:00",
    refundReason: "Session cancelled by consultant",
  },
  {
    id: "PAY-005",
    transactionId: "TXN_123456793",
    user: { name: "Alex Brown", email: "alex@example.com" },
    amount: 2000,
    type: "consultation",
    status: "refunded",
    paymentMethod: "UPI",
    createdAt: "2025-12-18T11:00:00",
  },
];

const refundRequests = [
  {
    id: "REF-001",
    paymentId: "PAY-004",
    user: { name: "Sarah Connor", email: "sarah@example.com" },
    amount: 3500,
    reason: "Session cancelled by consultant",
    status: "pending",
    createdAt: "2025-12-19T15:00:00",
  },
  {
    id: "REF-002",
    paymentId: "PAY-006",
    user: { name: "Emily Chen", email: "emily@example.com" },
    amount: 2500,
    reason: "Technical issues during session",
    status: "pending",
    createdAt: "2025-12-19T10:00:00",
  },
  {
    id: "REF-003",
    paymentId: "PAY-007",
    user: { name: "David Lee", email: "david@example.com" },
    amount: 4000,
    reason: "Consultant no-show",
    status: "approved",
    createdAt: "2025-12-18T16:00:00",
  },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case "completed":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "pending":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "failed":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "refund_requested":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "refunded":
      return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
    case "approved":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getTypeColor = (type: string) => {
  switch (type) {
    case "consultation":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "subscription":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    case "webinar":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "class":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
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
  const [activeTab, setActiveTab] = useState("payments");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedPayment, setSelectedPayment] = useState<
    (typeof payments)[0] | null
  >(null);
  const [selectedRefund, setSelectedRefund] = useState<
    (typeof refundRequests)[0] | null
  >(null);

  const filteredPayments = payments.filter((payment) => {
    const matchesSearch =
      payment.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payment.transactionId.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payment.user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payment.user.email.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === "all" || payment.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const stats = {
    totalTransactions: payments.length,
    totalAmount: payments
      .filter((p) => p.status === "completed")
      .reduce((sum, p) => sum + p.amount, 0),
    pendingRefunds: refundRequests.filter((r) => r.status === "pending").length,
    failedPayments: payments.filter((p) => p.status === "failed").length,
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
              <p className="text-sm text-zinc-500">Total Transactions</p>
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
                {formatCurrency(stats.totalAmount)}
              </p>
              <p className="text-sm text-zinc-500">Processed Today</p>
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
              <p className="text-sm text-zinc-500">Failed Payments</p>
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
            <Badge variant="secondary" className="ml-1">
              {refundRequests.filter((r) => r.status === "pending").length}
            </Badge>
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
                    placeholder="Search by ID, transaction ID, user..."
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
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="refund_requested">
                      Refund Requested
                    </SelectItem>
                    <SelectItem value="refunded">Refunded</SelectItem>
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
                    <TableHead>Payment ID</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPayments.map((payment) => (
                    <TableRow
                      key={payment.id}
                      className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                      onClick={() => setSelectedPayment(payment)}
                    >
                      <TableCell>
                        <div>
                          <p className="font-mono text-sm">{payment.id}</p>
                          <p className="text-xs text-zinc-400">
                            {payment.transactionId}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            <AvatarFallback className="text-xs">
                              {payment.user.name
                                .split(" ")
                                .map((n) => n[0])
                                .join("")}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-sm">{payment.user.name}</p>
                            <p className="text-xs text-zinc-400">
                              {payment.user.email}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatCurrency(payment.amount)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={getTypeColor(payment.type)}
                          variant="secondary"
                        >
                          {payment.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-zinc-600 dark:text-zinc-400">
                        {payment.paymentMethod}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={getStatusColor(payment.status)}
                          variant="secondary"
                        >
                          {payment.status.replace("_", " ")}
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
                            {payment.status === "failed" && (
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
            </CardContent>
          </Card>
        </TabsContent>

        {/* Refunds Tab */}
        <TabsContent value="refunds" className="space-y-4">
          <div className="space-y-3">
            {refundRequests.map((refund) => (
              <Card
                key={refund.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setSelectedRefund(refund)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <Avatar>
                        <AvatarFallback>
                          {refund.user.name
                            .split(" ")
                            .map((n) => n[0])
                            .join("")}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{refund.user.name}</p>
                          <Badge
                            className={getStatusColor(refund.status)}
                            variant="secondary"
                          >
                            {refund.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-zinc-500">
                          {refund.user.email}
                        </p>
                        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                          {refund.reason}
                        </p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
                          <span>Payment: {refund.paymentId}</span>
                          <span>Amount: {formatCurrency(refund.amount)}</span>
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-zinc-400">
                      {formatDate(refund.createdAt)}
                    </span>
                  </div>
                  {refund.status === "pending" && (
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
                  {selectedPayment.id} • {selectedPayment.transactionId}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarFallback>
                        {selectedPayment.user.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{selectedPayment.user.name}</p>
                      <p className="text-sm text-zinc-500">
                        {selectedPayment.user.email}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold">
                      {formatCurrency(selectedPayment.amount)}
                    </p>
                    <Badge
                      className={getStatusColor(selectedPayment.status)}
                      variant="secondary"
                    >
                      {selectedPayment.status.replace("_", " ")}
                    </Badge>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-zinc-500">Type</Label>
                    <p className="capitalize">{selectedPayment.type}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">
                      Payment Method
                    </Label>
                    <p>{selectedPayment.paymentMethod}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">Date</Label>
                    <p>{formatDate(selectedPayment.createdAt)}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">
                      Transaction ID
                    </Label>
                    <p className="font-mono text-sm">
                      {selectedPayment.transactionId}
                    </p>
                  </div>
                </div>
                {selectedPayment.failureReason && (
                  <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800">
                    <Label className="text-xs text-red-600">
                      Failure Reason
                    </Label>
                    <p className="text-sm text-red-700 dark:text-red-300">
                      {selectedPayment.failureReason}
                    </p>
                  </div>
                )}
                {selectedPayment.refundReason && (
                  <div className="p-3 rounded-lg bg-purple-50 dark:bg-purple-950 border border-purple-200 dark:border-purple-800">
                    <Label className="text-xs text-purple-600">
                      Refund Reason
                    </Label>
                    <p className="text-sm text-purple-700 dark:text-purple-300">
                      {selectedPayment.refundReason}
                    </p>
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
