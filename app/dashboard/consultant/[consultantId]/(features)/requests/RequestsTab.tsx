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
import { toast } from "@/components/ui/use-toast";
import { RequestsTabProps } from "../../types";
import { RequestStatus } from "@prisma/client";

type ConfirmDialogState = {
  isOpen: boolean;
  approvalId: string;
  approvalType: string;
  action: "APPROVED" | "REJECTED";
};

export function RequestsTab({ approvals, onUpdate }: Readonly<RequestsTabProps>) {
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
    // Prevent double submission
    if (loadingStates[id]) return;
    
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
    
    // Prevent double submission
    if (loadingStates[approvalId]) return;
    
    setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
    setLoadingStates((prev) => ({ ...prev, [approvalId]: true }));

    try {

      const endpoint =
        approvalType === "Consultation"
          ? `/api/events/consultations/${approvalId}`
          : `/api/events/subscriptions/${approvalId}`;

      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          status: action as RequestStatus 
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to update status");
      }

      toast({
        title: "Success",
        description: `Request ${action.toLowerCase()} successfully`,
      });

      // Add a small delay before triggering refresh to allow transaction to complete
      setTimeout(() => {
        if (onUpdate) {
          onUpdate();
        }
      }, 1000);
    } catch (error) {
      console.error("Error updating status:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update request status",
        variant: "destructive",
      });
    } finally {
      setLoadingStates((prev) => ({ ...prev, [approvalId]: false }));
    }
  };

  return (
    <>
      <div className="bg-white rounded-lg">
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
                    <div className="flex flex-col space-y-2">
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
                  <TableCell colSpan={5} className="text-center text-gray-500 py-4">
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
                  ? "bg-green-500 hover:bg-green-600"
                  : "bg-red-500 hover:bg-red-600"
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
