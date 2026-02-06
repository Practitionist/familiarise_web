"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { use, useState } from "react";
import { formatAmountFromPaise } from "@/lib/utils";
import type { DisputeDetails } from "@/types/disputes";

// Fetch dispute details
async function fetchDisputeDetails(disputeId: string): Promise<DisputeDetails> {
  const response = await fetch(`/api/admin/disputes/${disputeId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch dispute details");
  }
  return response.json() as Promise<DisputeDetails>;
}

// Submit dispute evidence
async function submitEvidence(data: {
  disputeId: string;
  evidence: Record<string, string | undefined>;
}): Promise<DisputeDetails> {
  const response = await fetch("/api/payments/disputes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to submit evidence");
  }

  return response.json() as Promise<DisputeDetails>;
}

interface PageProps {
  params: Promise<{ disputeId: string }>;
}

export default function DisputeDetailsPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [customerSignature, setCustomerSignature] = useState("");
  const [refundPolicy, setRefundPolicy] = useState("");
  const [refundPolicyDisclosure, setRefundPolicyDisclosure] = useState("");
  const [cancellationPolicy, setCancellationPolicy] = useState("");
  const [cancellationRebuttal, setCancellationRebuttal] = useState("");
  const [additionalEvidence, setAdditionalEvidence] = useState("");
  const [showEvidenceForm, setShowEvidenceForm] = useState(false);

  const {
    data: dispute,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["admin-dispute", resolvedParams.disputeId],
    queryFn: () => fetchDisputeDetails(resolvedParams.disputeId),
    staleTime: 30 * 1000,
  });

  const evidenceMutation = useMutation({
    mutationFn: submitEvidence,
    onSuccess: () => {
      toast({
        title: "Evidence Submitted",
        description: "Dispute evidence has been submitted successfully.",
      });
      queryClient.invalidateQueries({
        queryKey: ["admin-dispute", resolvedParams.disputeId],
      });
      setShowEvidenceForm(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Submission Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmitEvidence = () => {
    if (!dispute) return;

    const evidence = {
      customerName: customerName || undefined,
      customerEmailAddress: customerEmail || undefined,
      productDescription: productDescription || undefined,
      customerSignature: customerSignature || undefined,
      refundPolicy: refundPolicy || undefined,
      refundPolicyDisclosure: refundPolicyDisclosure || undefined,
      cancellationPolicy: cancellationPolicy || undefined,
      cancellationRebuttal: cancellationRebuttal || undefined,
      uncategorizedText: additionalEvidence || undefined,
    };

    evidenceMutation.mutate({
      disputeId: dispute.disputeId,
      evidence,
    });
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700">
              {error instanceof Error
                ? error.message
                : "Failed to load dispute details"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !dispute) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  const isUrgent =
    dispute.dueBy &&
    new Date(dispute.dueBy) < new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  const canSubmitEvidence = [
    "NEEDS_RESPONSE",
    "WARNING_NEEDS_RESPONSE",
    "UNDER_REVIEW",
  ].includes(dispute.status);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/dashboard/admin/disputes"
            className="text-sm text-blue-600 hover:text-blue-700 mb-2 inline-block"
          >
            ← Back to Disputes
          </Link>
          <h1 className="text-3xl font-bold text-gray-900">Dispute Details</h1>
        </div>
        {canSubmitEvidence && !showEvidenceForm && (
          <Button onClick={() => setShowEvidenceForm(true)}>
            Submit Evidence
          </Button>
        )}
      </div>

      {/* Urgency Alert */}
      {isUrgent && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <span className="text-2xl">⚠️</span>
              <div>
                <p className="font-semibold text-red-900">
                  Urgent: Response due by{" "}
                  {new Date(dispute.dueBy!).toLocaleDateString()}
                </p>
                <p className="text-sm text-red-700">
                  This dispute requires immediate attention. Submit evidence as
                  soon as possible.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Dispute Info */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Dispute Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-gray-500">Dispute ID</Label>
              <p className="font-mono text-sm">{dispute.disputeId}</p>
            </div>
            <div>
              <Label className="text-gray-500">Amount</Label>
              <p className="text-2xl font-bold">
                {formatAmountFromPaise(dispute.amount, dispute.currency)}
              </p>
            </div>
            <div>
              <Label className="text-gray-500">Status</Label>
              <div className="mt-1">
                <span
                  className={`px-3 py-1 rounded text-sm font-medium ${
                    dispute.status === "WON"
                      ? "bg-green-100 text-green-800"
                      : dispute.status === "LOST"
                        ? "bg-red-100 text-red-800"
                        : "bg-yellow-100 text-yellow-800"
                  }`}
                >
                  {dispute.status.replace(/_/g, " ")}
                </span>
              </div>
            </div>
            <div>
              <Label className="text-gray-500">Payment Gateway</Label>
              <p className="font-medium">{dispute.paymentGateway}</p>
            </div>
            <div>
              <Label className="text-gray-500">Reason</Label>
              <p className="text-gray-900">{dispute.reason}</p>
            </div>
            <div>
              <Label className="text-gray-500">Created At</Label>
              <p>{new Date(dispute.createdAt).toLocaleString()}</p>
            </div>
            {dispute.dueBy && (
              <div>
                <Label className="text-gray-500">Response Due By</Label>
                <p className={isUrgent ? "text-red-600 font-medium" : ""}>
                  {new Date(dispute.dueBy).toLocaleString()}
                </p>
              </div>
            )}
            <div>
              <Label className="text-gray-500">Charge Refundable</Label>
              <p>{dispute.isChargeRefundable ? "Yes" : "No"}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-gray-500">Payment ID</Label>
              <p className="font-mono text-sm">
                {dispute.payment?.paymentIntent}
              </p>
            </div>
            <div>
              <Label className="text-gray-500">Payment Status</Label>
              <p className="font-medium">{dispute.payment?.paymentStatus}</p>
            </div>
            <div>
              <Label className="text-gray-500">Customer</Label>
              <p>{dispute.payment?.user?.name || "N/A"}</p>
              <p className="text-sm text-gray-500">
                {dispute.payment?.user?.email}
              </p>
            </div>
            <Link
              href={`/dashboard/admin/payments/${dispute.paymentId}`}
              className="block text-blue-600 hover:text-blue-700 font-medium"
            >
              View Full Payment Details →
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Existing Evidence */}
      {dispute.evidence && (
        <Card>
          <CardHeader>
            <CardTitle>Submitted Evidence</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-gray-50 p-4 rounded-lg overflow-auto text-sm">
              {JSON.stringify(dispute.evidence, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Evidence Submission Form */}
      {showEvidenceForm && canSubmitEvidence && (
        <Card className="border-blue-200">
          <CardHeader>
            <CardTitle className="text-blue-600">Submit Evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="customerName">Customer Name</Label>
                <Textarea
                  id="customerName"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  rows={2}
                />
              </div>
              <div>
                <Label htmlFor="customerEmail">Customer Email</Label>
                <Textarea
                  id="customerEmail"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  rows={2}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="productDescription">
                Product/Service Description
              </Label>
              <Textarea
                id="productDescription"
                value={productDescription}
                onChange={(e) => setProductDescription(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="customerSignature">
                Customer Signature/Acknowledgment
              </Label>
              <Textarea
                id="customerSignature"
                value={customerSignature}
                onChange={(e) => setCustomerSignature(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="refundPolicy">Refund Policy</Label>
              <Textarea
                id="refundPolicy"
                value={refundPolicy}
                onChange={(e) => setRefundPolicy(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="refundPolicyDisclosure">
                Refund Policy Disclosure
              </Label>
              <Textarea
                id="refundPolicyDisclosure"
                value={refundPolicyDisclosure}
                onChange={(e) => setRefundPolicyDisclosure(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="cancellationPolicy">Cancellation Policy</Label>
              <Textarea
                id="cancellationPolicy"
                value={cancellationPolicy}
                onChange={(e) => setCancellationPolicy(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="cancellationRebuttal">
                Cancellation Rebuttal
              </Label>
              <Textarea
                id="cancellationRebuttal"
                value={cancellationRebuttal}
                onChange={(e) => setCancellationRebuttal(e.target.value)}
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="additionalEvidence">
                Additional Evidence/Notes
              </Label>
              <Textarea
                id="additionalEvidence"
                value={additionalEvidence}
                onChange={(e) => setAdditionalEvidence(e.target.value)}
                rows={4}
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleSubmitEvidence}
                disabled={evidenceMutation.isPending}
              >
                {evidenceMutation.isPending
                  ? "Submitting..."
                  : "Submit Evidence"}
              </Button>
              <Button
                onClick={() => setShowEvidenceForm(false)}
                variant="outline"
                disabled={evidenceMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Gateway-specific Notes */}
      <Card>
        <CardHeader>
          <CardTitle>Important Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-gray-600">
          <p>
            • Stripe disputes: You can submit evidence directly through this
            form.
          </p>
          <p>
            • Razorpay disputes: Evidence submission is handled automatically
            via webhooks. Contact Razorpay support for manual intervention.
          </p>
          <p>
            • Always respond before the due date to avoid automatic loss of the
            dispute.
          </p>
          <p>
            • Be thorough and provide all relevant documentation to support your
            case.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
