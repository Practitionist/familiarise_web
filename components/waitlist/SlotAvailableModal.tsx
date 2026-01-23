"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Clock, Calendar, Loader2, Check, X, RotateCcw } from "lucide-react";

interface SlotAvailableModalProps {
  isOpen: boolean;
  onClose: () => void;
  waitlistId: string;
  eventTitle: string;
  eventType: "webinar" | "class";
  scheduledDate?: Date | string;
  expiresAt: Date | string;
}

export function SlotAvailableModal({
  isOpen,
  onClose,
  waitlistId,
  eventTitle,
  eventType,
  scheduledDate,
  expiresAt,
}: SlotAvailableModalProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string>("");

  // Calculate time remaining
  useEffect(() => {
    const updateTimeRemaining = () => {
      const now = new Date();
      const expires = new Date(expiresAt);
      const diff = expires.getTime() - now.getTime();

      if (diff <= 0) {
        setTimeRemaining("Expired");
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

      if (hours > 0) {
        setTimeRemaining(`${hours}h ${minutes}m remaining`);
      } else {
        setTimeRemaining(`${minutes}m remaining`);
      }
    };

    updateTimeRemaining();
    const interval = setInterval(updateTimeRemaining, 60000); // Update every minute

    return () => clearInterval(interval);
  }, [expiresAt]);

  const handleAction = async (action: "ACCEPT" | "DECLINE" | "SKIP") => {
    setIsLoading(action);

    try {
      const response = await fetch(`/api/waitlist/${waitlistId}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });

      const result = await response.json();

      if (result.success) {
        if (action === "ACCEPT" && result.redirectUrl) {
          toast({
            title: "Redirecting to checkout",
            description: "Complete your booking to secure your spot!",
            variant: "success",
          });
          router.push(result.redirectUrl);
        } else {
          toast({
            title: "Response recorded",
            description: result.message,
            variant: "success",
          });
          onClose();
        }
      } else {
        toast({
          title: "Error",
          description: result.error || "Something went wrong",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to process your response. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(null);
    }
  };

  const eventTypeLabel = eventType === "webinar" ? "Webinar" : "Class";
  const formattedScheduledDate = scheduledDate
    ? new Date(scheduledDate).toLocaleString(undefined, {
        dateStyle: "long",
        timeStyle: "short",
      })
    : null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-4">
            <Check className="h-6 w-6 text-green-600" />
          </div>
          <DialogTitle className="text-center">A Spot is Available!</DialogTitle>
          <DialogDescription className="text-center">
            A spot has opened up for <strong>{eventTitle}</strong>. Would you like
            to book it now?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="bg-gray-50 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">{eventTypeLabel}</span>
              <span className="font-medium">{eventTitle}</span>
            </div>
            {formattedScheduledDate && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500 flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  Date
                </span>
                <span className="font-medium">{formattedScheduledDate}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500 flex items-center gap-1">
                <Clock className="h-4 w-4" />
                Time Left
              </span>
              <span
                className={`font-medium ${
                  timeRemaining === "Expired"
                    ? "text-red-600"
                    : timeRemaining.includes("m remaining") && !timeRemaining.includes("h")
                    ? "text-amber-600"
                    : "text-green-600"
                }`}
              >
                {timeRemaining}
              </span>
            </div>
          </div>

          <div className="text-xs text-center text-gray-500">
            If you don't respond within the time limit, the spot will be offered
            to the next person in the queue.
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-col gap-2">
          <Button
            onClick={() => handleAction("ACCEPT")}
            disabled={!!isLoading || timeRemaining === "Expired"}
            className="w-full bg-green-600 hover:bg-green-700"
          >
            {isLoading === "ACCEPT" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-2" />
            )}
            Book Now
          </Button>

          <div className="flex gap-2 w-full">
            <Button
              variant="outline"
              onClick={() => handleAction("SKIP")}
              disabled={!!isLoading}
              className="flex-1"
            >
              {isLoading === "SKIP" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4 mr-2" />
              )}
              Skip
            </Button>
            <Button
              variant="outline"
              onClick={() => handleAction("DECLINE")}
              disabled={!!isLoading}
              className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              {isLoading === "DECLINE" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <X className="h-4 w-4 mr-2" />
              )}
              Leave
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SlotAvailableModal;
