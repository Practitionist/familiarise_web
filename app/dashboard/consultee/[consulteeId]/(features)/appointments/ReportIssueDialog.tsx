"use client";

import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SupportPriority, SupportIssueType } from "@prisma/client";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, Calendar, User, Tag, Loader2, Send } from "lucide-react";
import {
  getFilteredIssueTypes,
  ISSUE_TYPE_LABELS,
  PRIORITY_OPTIONS,
  type AppointmentStatus,
} from "@/utils/supportTicketUrl";
import { format } from "date-fns";

interface ReportIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointmentId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR";
  appointmentStatus: AppointmentStatus;
  consultantName: string;
  scheduledAt?: string;
  onSuccess?: () => void;
}

export function ReportIssueDialog({
  open,
  onOpenChange,
  appointmentId,
  appointmentType,
  appointmentStatus,
  consultantName,
  scheduledAt,
  onSuccess,
}: ReportIssueDialogProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = React.useState(false);

  // Form state
  const [issueType, setIssueType] = React.useState<
    SupportIssueType | undefined
  >();
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [priority, setPriority] = React.useState<SupportPriority>(
    SupportPriority.MEDIUM,
  );

  // Get filtered issue types based on appointment status
  const filteredIssueTypes = React.useMemo(() => {
    return getFilteredIssueTypes(appointmentStatus);
  }, [appointmentStatus]);

  // Format the scheduled date
  const formattedDate = React.useMemo(() => {
    if (!scheduledAt) return null;
    try {
      const date = new Date(scheduledAt);
      return format(date, "EEE, MMM d, yyyy 'at' h:mm a");
    } catch {
      return scheduledAt;
    }
  }, [scheduledAt]);

  // Reset form when dialog closes
  React.useEffect(() => {
    if (!open) {
      setIssueType(undefined);
      setTitle("");
      setDescription("");
      setPriority(SupportPriority.MEDIUM);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!issueType || !title || !description) {
      toast({
        title: "Missing fields",
        description: "Please fill in all required fields.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      // Build request body with context linking
      const requestBody: Record<string, unknown> = {
        title,
        description,
        priority,
        issueType,
      };

      // Link to appointment - API will resolve to correct consultation/subscription
      requestBody.appointmentId = appointmentId;

      const response = await fetch("/api/user/support-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            errorData.message ||
            "Failed to create support ticket",
        );
      }

      toast({
        title: "Issue reported",
        description:
          "Your support ticket has been created and linked to this appointment.",
      });

      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      console.error("Failed to create support ticket:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to create support ticket. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const typeLabel =
    appointmentType === "CONSULTATION"
      ? "Consultation"
      : appointmentType === "WEBINAR"
        ? "Webinar"
        : "Subscription";
  const statusLabel =
    appointmentStatus === "COMPLETED" ? "Completed" : "Upcoming";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto scrollbar-hide">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            Report an Issue
          </DialogTitle>
          <DialogDescription>
            Let us know what went wrong with your {typeLabel.toLowerCase()}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-4">
          {/* Appointment Context Card */}
          <div className="p-4 rounded-xl bg-gradient-to-r from-zinc-50 to-zinc-100 border border-zinc-200">
            <div className="flex items-center gap-2 text-xs text-zinc-500 mb-3">
              <Calendar className="h-3.5 w-3.5" />
              <span>Linked to {typeLabel}</span>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-zinc-400" />
                <span className="font-medium text-zinc-800">
                  {consultantName}
                </span>
              </div>
              {formattedDate && (
                <div className="flex items-center gap-2 text-sm text-zinc-600">
                  <Calendar className="h-4 w-4 text-zinc-400" />
                  <span>{formattedDate}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Tag className="h-4 w-4 text-zinc-400" />
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-200 text-zinc-700">
                  {statusLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Issue Type */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-zinc-700">
              What&apos;s this about? <span className="text-red-500">*</span>
            </Label>
            <Select
              value={issueType}
              onValueChange={(value) => setIssueType(value as SupportIssueType)}
            >
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Select issue type" />
              </SelectTrigger>
              <SelectContent>
                {filteredIssueTypes.map((type) => {
                  const label = ISSUE_TYPE_LABELS[type];
                  if (!label) return null;
                  return (
                    <SelectItem key={type} value={type}>
                      {label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Subject */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-zinc-700">
              Subject <span className="text-red-500">*</span>
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Brief summary of your issue"
              className="h-11"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-zinc-700">
              Description <span className="text-red-500">*</span>
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Please describe your issue in detail..."
              className="min-h-[120px] resize-none"
            />
          </div>

          {/* Priority */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-zinc-700">
              Priority
            </Label>
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value as SupportPriority)}
            >
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Select priority" />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className={option.color}>{option.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isLoading || !issueType || !title || !description}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Submitting...
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                Submit Report
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
