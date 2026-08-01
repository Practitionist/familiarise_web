"use client";

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
import { Loader2, AlertTriangle } from "lucide-react";

interface CancelConfirmationDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  consultant: string;
  appointmentType: string;
  isLoading?: boolean;
  /**
   * Booking is APPROVED_PENDING_PAYMENT — nothing has been charged, so the
   * dialog reads as "cancel the request" rather than warning about an
   * irreversible cancellation of a paid session.
   */
  isPendingPayment?: boolean;
  /**
   * #1005 — group self-leave uses different copy than a full booking cancel.
   */
  mode?: "cancel" | "leave";
}

export function CancelConfirmationDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  consultant,
  appointmentType,
  isLoading = false,
  isPendingPayment = false,
  mode = "cancel",
}: Readonly<CancelConfirmationDialogProps>) {
  const isLeave = mode === "leave";
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            {isLeave
              ? `Leave ${appointmentType}?`
              : isPendingPayment
                ? `Cancel ${appointmentType} request?`
                : `Cancel ${appointmentType}?`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Are you sure you want to {isLeave ? "leave" : "cancel"}{" "}
                <strong>&quot;{title}&quot;</strong> with{" "}
                <strong>{consultant}</strong>?
              </p>
              {isLeave ? (
                <p className="text-muted-foreground text-sm">
                  You will be removed from this event. If you paid for a seat,
                  a refund is issued under the event&apos;s cancellation policy.
                </p>
              ) : isPendingPayment ? (
                <p className="text-muted-foreground">
                  You haven&apos;t been charged — this releases the approved
                  request without any payment.
                </p>
              ) : (
                <>
                  <p className="text-red-600 font-medium">
                    This action cannot be undone.
                  </p>
                  {(appointmentType === "Consultation" ||
                    appointmentType === "Subscription" ||
                    appointmentType === "Trial") && (
                    <p className="text-muted-foreground text-sm">
                      If a payment was captured, any refund follows the
                      booking&apos;s cancellation policy.
                    </p>
                  )}
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isLoading}>
            {isLeave ? "Stay enrolled" : "Keep Appointment"}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isLoading}
            className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {isLeave ? "Leaving..." : "Cancelling..."}
              </>
            ) : isLeave ? (
              "Yes, Leave"
            ) : (
              "Yes, Cancel"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
