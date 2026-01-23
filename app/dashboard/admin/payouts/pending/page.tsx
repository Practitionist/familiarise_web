"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X, Loader2 } from "lucide-react";

interface Payout {
  id: string;
  consultantName: string;
  consultantEmail: string;
  amount: number;
  currency: string;
  method: string;
  provider: string;
  earningsCount: number;
  batchId: string;
  createdAt: string;
}

async function fetchPendingPayouts() {
  const response = await fetch("/api/admin/payouts?status=PENDING&limit=100");
  if (!response.ok) {
    throw new Error("Failed to fetch payouts");
  }
  return response.json();
}

async function approvePayout(id: string) {
  const response = await fetch(`/api/admin/payouts/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to approve payout");
  }
  return response.json();
}

async function rejectPayout(id: string, reason: string) {
  const response = await fetch(`/api/admin/payouts/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reject", reason }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to reject payout");
  }
  return response.json();
}

export default function PendingPayoutsPage() {
  const queryClient = useQueryClient();
  const [selectedPayout, setSelectedPayout] = useState<Payout | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [dialogType, setDialogType] = useState<"approve" | "reject" | null>(
    null,
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-payouts-pending"],
    queryFn: fetchPendingPayouts,
    staleTime: 30 * 1000,
  });

  const approveMutation = useMutation({
    mutationFn: approvePayout,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-payouts-pending"] });
      queryClient.invalidateQueries({ queryKey: ["admin-payout-stats"] });
      setDialogType(null);
      setSelectedPayout(null);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectPayout(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-payouts-pending"] });
      queryClient.invalidateQueries({ queryKey: ["admin-payout-stats"] });
      setDialogType(null);
      setSelectedPayout(null);
      setRejectReason("");
    },
  });

  const handleApprove = (payout: Payout) => {
    setSelectedPayout(payout);
    setDialogType("approve");
  };

  const handleReject = (payout: Payout) => {
    setSelectedPayout(payout);
    setDialogType("reject");
  };

  const confirmApprove = () => {
    if (selectedPayout) {
      approveMutation.mutate(selectedPayout.id);
    }
  };

  const confirmReject = () => {
    if (selectedPayout && rejectReason.trim()) {
      rejectMutation.mutate({ id: selectedPayout.id, reason: rejectReason });
    }
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
                : "Failed to load payouts"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Pending Approval</h1>
        <p className="text-gray-600 mt-1">
          Review and approve consultant payouts
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Pending Payouts ({data?.payouts?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.payouts?.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Consultant
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Method
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Earnings
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {data.payouts.map((payout: Payout) => (
                    <tr key={payout.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {payout.consultantName}
                          </p>
                          <p className="text-xs text-gray-500">
                            {payout.consultantEmail}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-gray-900">
                        {(payout.amount / 100).toLocaleString("en-IN", {
                          style: "currency",
                          currency: payout.currency,
                        })}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {payout.method}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {payout.earningsCount} earnings
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {new Date(payout.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-green-600 border-green-600 hover:bg-green-50"
                            onClick={() => handleApprove(payout)}
                          >
                            <Check className="w-4 h-4 mr-1" />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 border-red-600 hover:bg-red-50"
                            onClick={() => handleReject(payout)}
                          >
                            <X className="w-4 h-4 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500">No pending payouts</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Approve Dialog */}
      <AlertDialog
        open={dialogType === "approve"}
        onOpenChange={() => setDialogType(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve Payout</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to approve this payout of{" "}
              {selectedPayout &&
                (selectedPayout.amount / 100).toLocaleString("en-IN", {
                  style: "currency",
                  currency: selectedPayout.currency,
                })}{" "}
              to {selectedPayout?.consultantName}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmApprove}
              disabled={approveMutation.isPending}
              className="bg-green-600 hover:bg-green-700"
            >
              {approveMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <AlertDialog
        open={dialogType === "reject"}
        onOpenChange={() => setDialogType(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Payout</AlertDialogTitle>
            <AlertDialogDescription>
              Please provide a reason for rejecting this payout to{" "}
              {selectedPayout?.consultantName}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Input
              placeholder="Reason for rejection..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmReject}
              disabled={rejectMutation.isPending || !rejectReason.trim()}
              className="bg-red-600 hover:bg-red-700"
            >
              {rejectMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
