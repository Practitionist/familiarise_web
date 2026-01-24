"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  AlertTriangle,
  Loader2,
  AlertCircle,
  Clock,
  CheckCircle,
  XCircle,
  CreditCard,
  User,
  Calendar,
  FileText,
  Lock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface DisputeDetails {
  id: string;
  disputeId: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  dueBy: string | null;
  evidence: string | null;
  evidenceSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  payment: {
    id: string;
    paymentIntent: string;
    amount: number;
    currency: string;
    paymentMethod: string | null;
    createdAt: string;
    user: {
      id: string;
      name: string | null;
      email: string;
    };
  } | null;
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
      return <CheckCircle className="h-4 w-4" />;
    case "LOST":
      return <XCircle className="h-4 w-4" />;
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return <AlertTriangle className="h-4 w-4" />;
    case "UNDER_REVIEW":
      return <Clock className="h-4 w-4" />;
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
  const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays;
};

export default function StaffDisputeDetailPage() {
  const { toast } = useToast();
  const router = useRouter();
  const params = useParams();
  const staffId = params.staffId as string;
  const disputeId = params.disputeId as string;

  const [dispute, setDispute] = useState<DisputeDetails | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDispute = async () => {
      try {
        const response = await fetch(`/api/admin/disputes/${disputeId}`);
        if (!response.ok) throw new Error("Failed to fetch dispute");

        const data = await response.json();
        setDispute(data);
      } catch (error) {
        console.error("Error fetching dispute:", error);
        toast({
          title: "Error",
          description: "Failed to load dispute details",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };

    fetchDispute();
  }, [disputeId, toast]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!dispute) {
    return (
      <div className="space-y-6">
        <Button
          variant="ghost"
          onClick={() => router.push(`/dashboard/staff/${staffId}/disputes`)}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Disputes
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center justify-center h-64 text-zinc-500">
            <AlertTriangle className="h-12 w-12 mb-4 text-zinc-300" />
            <p>Dispute not found</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const daysUntilDue = getDaysUntilDue(dispute.dueBy);
  const isUrgent = daysUntilDue !== null && daysUntilDue <= 3 && daysUntilDue >= 0;
  const needsResponse = dispute.status === "NEEDS_RESPONSE" || dispute.status === "WARNING_NEEDS_RESPONSE";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => router.push(`/dashboard/staff/${staffId}/disputes`)}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              Dispute Details
            </h1>
            <p className="text-zinc-500 dark:text-zinc-400 font-mono">
              {dispute.disputeId || dispute.id.slice(-12).toUpperCase()}
            </p>
          </div>
        </div>
        <Badge
          className={`${getStatusColor(dispute.status)} gap-1 text-sm px-3 py-1`}
          variant="secondary"
        >
          {getStatusIcon(dispute.status)}
          {dispute.status.toLowerCase().replace(/_/g, " ")}
        </Badge>
      </div>

      {/* Urgent Alert */}
      {isUrgent && needsResponse && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Urgent: Response Required</AlertTitle>
          <AlertDescription>
            This dispute is due {daysUntilDue === 0 ? "today" : `in ${daysUntilDue} days`}.
            Please escalate to an admin immediately for evidence submission.
          </AlertDescription>
        </Alert>
      )}

      {/* Staff Notice */}
      <Alert>
        <Lock className="h-4 w-4" />
        <AlertTitle>Staff View (Read-Only)</AlertTitle>
        <AlertDescription>
          As a staff member, you can view dispute details but cannot submit evidence.
          Please escalate to an admin if action is required.
        </AlertDescription>
      </Alert>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Dispute Information */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              Dispute Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-zinc-500">Dispute Amount</p>
                <p className="text-xl font-bold">
                  {formatCurrency(dispute.amount, dispute.currency)}
                </p>
              </div>
              <div>
                <p className="text-sm text-zinc-500">Payment Gateway</p>
                <p className="font-medium">{dispute.paymentGateway}</p>
              </div>
            </div>

            <Separator />

            <div>
              <p className="text-sm text-zinc-500">Reason</p>
              <p className="font-medium">{dispute.reason || "Not specified"}</p>
            </div>

            {dispute.dueBy && (
              <div className={isUrgent ? "p-3 rounded-lg bg-red-50 dark:bg-red-950/20" : ""}>
                <p className="text-sm text-zinc-500">Response Due By</p>
                <p className={`font-medium ${isUrgent ? "text-red-600" : ""}`}>
                  {formatDate(dispute.dueBy)}
                </p>
                {daysUntilDue !== null && daysUntilDue >= 0 && (
                  <p className={`text-sm ${isUrgent ? "text-red-500" : "text-zinc-400"}`}>
                    {daysUntilDue === 0 ? "Due today!" : `${daysUntilDue} days remaining`}
                  </p>
                )}
              </div>
            )}

            <Separator />

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-zinc-500">Created</p>
                <p className="font-medium">{formatDate(dispute.createdAt)}</p>
              </div>
              <div>
                <p className="text-sm text-zinc-500">Last Updated</p>
                <p className="font-medium">{formatDate(dispute.updatedAt)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Payment Information */}
        {dispute.payment && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-blue-600" />
                Payment Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm text-zinc-500">Payment ID</p>
                <p className="font-mono text-sm">{dispute.payment.paymentIntent}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-zinc-500">Amount</p>
                  <p className="font-medium">
                    {formatCurrency(dispute.payment.amount, dispute.payment.currency)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-zinc-500">Payment Method</p>
                  <p className="font-medium">
                    {dispute.payment.paymentMethod || "N/A"}
                  </p>
                </div>
              </div>

              <Separator />

              <div className="flex items-center gap-3">
                <User className="h-5 w-5 text-zinc-400" />
                <div>
                  <p className="font-medium">
                    {dispute.payment.user.name || "Unknown User"}
                  </p>
                  <p className="text-sm text-zinc-500">{dispute.payment.user.email}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Calendar className="h-5 w-5 text-zinc-400" />
                <div>
                  <p className="text-sm text-zinc-500">Payment Date</p>
                  <p className="font-medium">{formatDate(dispute.payment.createdAt)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Evidence Section (Read-Only) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="h-5 w-5 text-purple-600" />
            Evidence
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dispute.evidence ? (
            <div className="space-y-4">
              <Alert className="bg-green-50 dark:bg-green-950/20 border-green-200">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <AlertTitle>Evidence Submitted</AlertTitle>
                <AlertDescription>
                  Evidence was submitted on {dispute.evidenceSubmittedAt ? formatDate(dispute.evidenceSubmittedAt) : "N/A"}
                </AlertDescription>
              </Alert>
              <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                <p className="text-sm whitespace-pre-wrap">{dispute.evidence}</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-500">
              <FileText className="h-12 w-12 mb-4 text-zinc-300" />
              <p className="font-medium">No evidence submitted yet</p>
              {needsResponse && (
                <p className="text-sm text-zinc-400 mt-2">
                  Please escalate to an admin to submit evidence
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
