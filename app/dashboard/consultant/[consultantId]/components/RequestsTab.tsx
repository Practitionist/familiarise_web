import React, { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { RequestsTabProps } from "../types";
import { toast } from "@/components/ui/use-toast";

type ConfirmDialogState = {
  isOpen: boolean;
  approvalId: string;
  approvalType: string;
  action: "APPROVED" | "REJECTED";
};

export function RequestsTab({ approvals }: RequestsTabProps) {
  const [loadingStates, setLoadingStates] = useState<{
    [key: string]: boolean;
  }>({});
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    approvalId: "",
    approvalType: "",
    action: "APPROVED",
  });

  const handleStatusUpdate = async (
    id: string,
    type: string,
    status: "APPROVED" | "REJECTED",
  ) => {
    // Show confirmation dialog
    setConfirmDialog({
      isOpen: true,
      approvalId: id,
      approvalType: type,
      action: status,
    });
  };

  const handleConfirmedUpdate = async () => {
    const { approvalId, approvalType, action } = confirmDialog;
    setConfirmDialog((prev) => ({ ...prev, isOpen: false }));

    try {
      setLoadingStates((prev) => ({ ...prev, [approvalId]: true }));

      const endpoint =
        approvalType === "Consultation"
          ? "/api/events/consultations"
          : "/api/events/subscriptions";

      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: approvalId, status: action }),
      });

      if (!response.ok) {
        throw new Error("Failed to update status");
      }

      toast({
        title: "Success",
        description: `Request ${action.toLowerCase()} successfully`,
      });

      // Optionally trigger a refresh of the approvals data
      // You might want to lift this state up to the parent component
      // and pass down a refresh function as a prop
    } catch (error) {
      console.error("Error updating status:", error);
      toast({
        title: "Error",
        description: "Failed to update request status",
        variant: "destructive",
      });
    } finally {
      setLoadingStates((prev) => ({ ...prev, [approvalId]: false }));
    }
  };

  return (
    <>
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-xl font-semibold mb-4">All Appointment Requests</h2>
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Client Name</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.map((approval) => (
                <TableRow key={approval.id}>
                  <TableCell>{approval.type}</TableCell>
                  <TableCell>{approval.name}</TableCell>
                  <TableCell>{approval.date}</TableCell>
                  <TableCell>{approval.time}</TableCell>
                  <TableCell>
                    <div className="flex space-x-2">
                      <Button
                        variant="default"
                        size="sm"
                        className="bg-green-500 hover:bg-green-600 min-w-[80px]"
                        onClick={() =>
                          handleStatusUpdate(
                            approval.id,
                            approval.type,
                            "APPROVED",
                          )
                        }
                        disabled={loadingStates[approval.id]}
                      >
                        {loadingStates[approval.id] ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Accept"
                        )}
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        className="bg-red-500 hover:bg-red-600 min-w-[80px]"
                        onClick={() =>
                          handleStatusUpdate(
                            approval.id,
                            approval.type,
                            "REJECTED",
                          )
                        }
                        disabled={loadingStates[approval.id]}
                      >
                        {loadingStates[approval.id] ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Reject"
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {approvals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-gray-500">
                    No pending approvals
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog
        open={confirmDialog.isOpen}
        onOpenChange={(open) =>
          setConfirmDialog((prev) => ({ ...prev, isOpen: open }))
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Action</DialogTitle>
            <DialogDescription>
              Are you sure you want to{" "}
              {confirmDialog.action === "APPROVED" ? "accept" : "reject"} this{" "}
              {confirmDialog.approvalType.toLowerCase()} request?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex space-x-2 justify-end">
            <Button
              variant="outline"
              onClick={() =>
                setConfirmDialog((prev) => ({ ...prev, isOpen: false }))
              }
            >
              Cancel
            </Button>
            <Button
              variant="default"
              className={
                confirmDialog.action === "APPROVED"
                  ? "bg-green-500"
                  : "bg-red-500"
              }
              onClick={handleConfirmedUpdate}
            >
              {confirmDialog.action === "APPROVED" ? "Accept" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
