"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const OUTBOUND_ISSUE_TYPES = [
  { value: "GENERAL_INQUIRY", label: "General Inquiry" },
  { value: "ACCOUNT_ISSUE", label: "Account Issue" },
  { value: "BILLING_QUESTION", label: "Billing Question" },
  { value: "REFUND_REQUEST", label: "Refund Follow-up" },
  { value: "DOCUMENT_ISSUE", label: "Document / Compliance Issue" },
  { value: "TECHNICAL_ISSUES", label: "Technical Issue" },
  { value: "OTHER", label: "Other" },
] as const;

type OutboundIssueType = (typeof OUTBOUND_ISSUE_TYPES)[number]["value"];
type SupportPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export function StaffSupportComposeDialog({
  open,
  onOpenChange,
  defaultTargetUserId = "",
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultTargetUserId?: string;
  onCreated?: (ticketId: string) => void;
}>) {
  const queryClient = useQueryClient();
  const [targetUserId, setTargetUserId] = useState(defaultTargetUserId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [issueType, setIssueType] =
    useState<OutboundIssueType>("GENERAL_INQUIRY");
  const [priority, setPriority] = useState<SupportPriority>("MEDIUM");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTargetUserId(defaultTargetUserId);
    setTitle("");
    setDescription("");
    setIssueType("GENERAL_INQUIRY");
    setPriority("MEDIUM");
    setError(null);
  };

  const createMutation = useMutation({
    mutationFn: async (payload: {
      targetUserId: string;
      title: string;
      description: string;
      issueType: OutboundIssueType;
      priority: SupportPriority;
    }) => {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string; message?: string }).message ??
            (json as { error?: string }).error ??
            "Failed to create outbound support ticket",
        );
      }
      return json as { id: string };
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["support-inbox"] });
      queryClient.invalidateQueries({ queryKey: ["support-inbox-stats"] });
      reset();
      onOpenChange(false);
      onCreated?.(created.id);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    const trimmedTarget = targetUserId.trim();
    if (!trimmedTarget) {
      setError("Target user ID or email is required.");
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Subject is required.");
      return;
    }
    const trimmedDesc = description.trim();
    if (!trimmedDesc) {
      setError("Message body is required.");
      return;
    }

    createMutation.mutate({
      targetUserId: trimmedTarget,
      title: trimmedTitle,
      description: trimmedDesc,
      issueType,
      priority,
    });
  };

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <ResponsiveModalContent className="sm:max-w-lg">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>
            New Outbound Support Ticket
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="outbound-target-user">
              Target user email or ID *
            </Label>
            <Input
              id="outbound-target-user"
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              placeholder="user@example.com or user_123"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="outbound-issue-type">Issue type *</Label>
              <Select
                value={issueType}
                onValueChange={(v) => setIssueType(v as OutboundIssueType)}
              >
                <SelectTrigger id="outbound-issue-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTBOUND_ISSUE_TYPES.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="outbound-priority">Priority *</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as SupportPriority)}
              >
                <SelectTrigger id="outbound-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOW">Low</SelectItem>
                  <SelectItem value="MEDIUM">Medium</SelectItem>
                  <SelectItem value="HIGH">High</SelectItem>
                  <SelectItem value="URGENT">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="outbound-title">Subject *</Label>
            <Input
              id="outbound-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Brief summary of the outreach"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="outbound-description">Message *</Label>
            <Textarea
              id="outbound-description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Write the message that will open the user's support case…"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ResponsiveModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Sending…
              </>
            ) : (
              <>
                <Send className="mr-1 h-4 w-4" /> Create Ticket
              </>
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
