"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { throwSupportError } from "@/lib/support/error-copy";
import {
  OutboundCaseResponse,
  outboundCaseNotice,
} from "@/lib/support/outbound-case";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { supportKeys } from "@/lib/support/support-keys";
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
import { UserSearchCombobox, type FoundUser } from "./UserSearchCombobox";

const OUTBOUND_ISSUE_TYPES = [
  { value: "GENERAL_INQUIRY", label: "General Inquiry" },
  { value: "ACCOUNT_ISSUE", label: "Account Issue" },
  { value: "BILLING_QUESTION", label: "Billing Question" },
  { value: "REFUND_REQUEST", label: "Refund Follow-up" },
  { value: "TAX_GST", label: "GST Invoice Correction" },
  { value: "TDS_CERTIFICATE", label: "TDS Certificate (Form 16A)" },
  { value: "PAN_CARD_MISMATCH", label: "PAN Mismatch" },
  { value: "DOCUMENT_ISSUE", label: "Document / Compliance Issue" },
  { value: "TECHNICAL_ISSUES", label: "Technical Issue" },
  { value: "OTHER", label: "Other" },
] as const;

type OutboundIssueType = (typeof OUTBOUND_ISSUE_TYPES)[number]["value"];
type SupportPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export function StaffSupportComposeDialog({
  open,
  onOpenChange,
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (ticketId: string) => void;
}>) {
  const intakeId = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const { basePath } = useBackofficeCapability();
  const [target, setTargetState] = useState<FoundUser | null>(null);
  // A retry may reuse the intake key only for the same customer.
  const setTarget = (user: FoundUser | null) => {
    if (user?.id !== target?.id) intakeId.current = null;
    setTargetState(user);
  };
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [issueType, setIssueType] =
    useState<OutboundIssueType>("GENERAL_INQUIRY");
  const [priority, setPriority] = useState<SupportPriority>("MEDIUM");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTarget(null);
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
      intakeId.current ??= crypto.randomUUID();
      const res = await fetch("/api/support/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requesterUserId: payload.targetUserId,
          title: payload.title,
          description: payload.description,
          issueType: payload.issueType,
          category: payload.issueType,
          priority: payload.priority,
          activeChannel: "HUMAN",
          clientIntakeId: intakeId.current,
        }),
      });
      if (!res.ok) await throwSupportError(res, "outbound support request");
      return OutboundCaseResponse.parse(await res.json());
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.inbox() });
      intakeId.current = null;
      reset();
      onOpenChange(false);
      const notice = outboundCaseNotice(result, basePath);
      if (notice) {
        toast({
          title: notice.title,
          description: notice.description,
          action: (
            <ToastAction
              altText={`Open ${result.data.referenceNumber}`}
              onClick={() => router.push(notice.href)}
            >
              Open case
            </ToastAction>
          ),
        });
      }
      onCreated?.(result.data.id);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError(null);
    if (!target) {
      setError("Choose who this request is for.");
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
      targetUserId: target.id,
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
            New outbound support request
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="outbound-target-user">Customer *</Label>
            <UserSearchCombobox
              id="outbound-target-user"
              value={target}
              onChange={setTarget}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="outbound-issue-type">Issue type *</Label>
              <Select
                value={issueType}
                onValueChange={(v) =>
                  setIssueType(
                    z
                      .enum([
                        "GENERAL_INQUIRY",
                        "ACCOUNT_ISSUE",
                        "BILLING_QUESTION",
                        "REFUND_REQUEST",
                        "TAX_GST",
                        "TDS_CERTIFICATE",
                        "PAN_CARD_MISMATCH",
                        "DOCUMENT_ISSUE",
                        "TECHNICAL_ISSUES",
                        "OTHER",
                      ])
                      .parse(v),
                  )
                }
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
                onValueChange={(v) =>
                  setPriority(
                    z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).parse(v),
                  )
                }
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
              placeholder="Write the message the customer will read…"
              aria-describedby="outbound-description-hint"
            />
            <p
              id="outbound-description-hint"
              className="text-xs text-muted-foreground"
            >
              A new case opens with this message. If the customer already has an
              open case, it is added there as a reply they can see.
            </p>
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
                <Send className="mr-1 h-4 w-4" /> Create request
              </>
            )}
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
