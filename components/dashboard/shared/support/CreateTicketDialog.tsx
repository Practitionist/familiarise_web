"use client";

/**
 * #support-hub — the direct "New request" dialog for PLATFORM tickets. The
 * flowchart intake stays the front door (it resolves most issues without a
 * queue); this is the explicit path for users who already know what they need.
 * Issue types are restricted to the platform taxonomy — session-specific
 * problems belong on the appointment's Get help thread (the server 422s them
 * here anyway, so the UI and API enforce the same line).
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { describeWait } from "@/components/support/useSupportThread";
import {
  SupportRequestError,
  throwSupportError,
} from "@/lib/support/error-copy";
import { MemberRole } from "@prisma/client";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { canRaiseAboutOrg } from "@/lib/support/about-org";
import { SupportPriority, type SupportCaseOwnership } from "@prisma/client";
import {
  ISSUE_TYPE_LABELS,
  PLATFORM_ISSUE_TYPE_CATEGORIES,
} from "@/utils/supportTicketUrl";

export interface CreateTicketDefaults {
  issueType?: string;
  title?: string;
  description?: string;
  /** Preselects "About" (#1527), e.g. org Billing's invoice request. */
  organizationId?: string;
  ownershipScope?: SupportCaseOwnership;
}

interface OrgMembership {
  organizationId: string;
  orgName: string;
  role: string;
  status: string;
}

/** "About" value for a personal request. */
const ABOUT_ME = "me";

const CreatedTicket = z.object({
  id: z.string(),
  referenceNumber: z.string().nullish(),
  ackDueAt: z.string().nullish(),
});

const PRIORITY_BY_VALUE: Record<string, SupportPriority> = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  URGENT: "URGENT",
};

export function CreateTicketDialog({
  trigger,
  defaults,
  requestHref,
}: {
  /** Custom trigger node; defaults to a "New request" button. */
  trigger?: React.ReactNode;
  /** Pre-fill, e.g. org Billing's "Request an invoice". */
  defaults?: CreateTicketDefaults;
  /** The new request's page; the dialog navigates there on create. */
  requestHref?: (ticketId: string) => string;
}) {
  const router = useRouter();
  const clientIntakeId = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [issueType, setIssueType] = useState<string>(defaults?.issueType ?? "");
  const [title, setTitle] = useState(defaults?.title ?? "");
  const [description, setDescription] = useState(defaults?.description ?? "");
  const [priority, setPriority] = useState<SupportPriority>("MEDIUM");
  const [ownershipScope, setOwnershipScope] = useState<
    "PERSONAL" | "ORG_OPERATIONS" | "ORG_BILLING"
  >(defaults?.ownershipScope ?? "PERSONAL");
  const [about, setAbout] = useState(defaults?.organizationId ?? ABOUT_ME);
  const [callbackRequested, setCallbackRequested] = useState(false);
  const [callbackPhone, setCallbackPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  const memberships = useQuery({
    queryKey: ["user-org-memberships"],
    queryFn: async (): Promise<OrgMembership[]> => {
      const res = await fetch("/api/user/org-memberships");
      if (!res.ok) return [];
      const { data } = await res.json();
      return data;
    },
    enabled: open,
    staleTime: 60_000,
  });
  const aboutOrgs = (memberships.data ?? []).filter(canRaiseAboutOrg);
  const selectedOrg = aboutOrgs.find((m) => m.organizationId === about);
  const parsedRole = z.nativeEnum(MemberRole).safeParse(selectedOrg?.role);
  const canOwnOperations =
    parsedRole.success &&
    hasOrgPermission(parsedRole.data, "supportCases.operations.manage");
  const canOwnBilling =
    parsedRole.success &&
    hasOrgPermission(parsedRole.data, "supportCases.billing.manage");

  const create = useMutation({
    mutationFn: async () => {
      clientIntakeId.current ??= crypto.randomUUID();
      const res = await fetch("/api/support/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueType,
          category: issueType,
          ownershipScope: about === ABOUT_ME ? "PERSONAL" : ownershipScope,
          clientIntakeId: clientIntakeId.current,
          title: title.trim(),
          description: description.trim(),
          priority,
          ...(callbackRequested && callbackPhone.trim()
            ? { callbackPhone: callbackPhone.trim() }
            : {}),
          ...(about !== ABOUT_ME && { organizationId: about }),
        }),
      });
      if (!res.ok) await throwSupportError(res, "request create");
      const payload = z.object({ data: CreatedTicket }).parse(await res.json());
      return payload.data;
    },
    onSuccess: (ticket) => {
      toast({
        title: ticket.referenceNumber
          ? `Request ${ticket.referenceNumber} created`
          : "Request created",
        description: describeWait(ticket.ackDueAt),
      });
      void qc.invalidateQueries({ queryKey: ["personal-support-requests"] });
      void qc.invalidateQueries({ queryKey: ["org-support-tickets"] });
      clientIntakeId.current = null;
      setOpen(false);
      setIssueType(defaults?.issueType ?? "");
      setTitle(defaults?.title ?? "");
      setDescription(defaults?.description ?? "");
      setPriority("MEDIUM");
      setCallbackRequested(false);
      setCallbackPhone("");
      setPhoneError(null);
      setAbout(defaults?.organizationId ?? ABOUT_ME);
      setOwnershipScope(defaults?.ownershipScope ?? "PERSONAL");
      if (requestHref) router.push(requestHref(ticket.id));
    },
    onError: (e: unknown) => {
      const fieldErrors =
        e instanceof SupportRequestError ? e.fieldErrors : undefined;
      setPhoneError(fieldErrors?.callbackPhone ?? null);
      const fieldMessage = fieldErrors
        ? Object.values(fieldErrors)[0]
        : undefined;
      toast({
        title: "Couldn't create request",
        description:
          fieldMessage ?? (e instanceof Error ? e.message : undefined),
        variant: "destructive",
      });
    },
  });

  const valid =
    !!issueType && title.trim().length > 0 && description.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus className="mr-1.5 h-4 w-4" />
            New request
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New support request</DialogTitle>
          <DialogDescription>
            Platform issues only — payments, account, sign-in, site trouble.
            Something wrong with a specific session? Open that appointment and
            use &quot;Get help&quot; instead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {aboutOrgs.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="new-ticket-about">About</Label>
              <Select
                value={about}
                onValueChange={(value) => {
                  setAbout(value);
                  setOwnershipScope("PERSONAL");
                }}
              >
                <SelectTrigger id="new-ticket-about">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ABOUT_ME}>Me</SelectItem>
                  {aboutOrgs.map((m) => (
                    <SelectItem key={m.organizationId} value={m.organizationId}>
                      {m.orgName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Choose whether this conversation belongs to you or an authorized
                organization team.
              </p>
            </div>
          )}

          {about !== ABOUT_ME && (canOwnOperations || canOwnBilling) && (
            <div className="space-y-2">
              <Label htmlFor="new-case-owner">Conversation owner</Label>
              <Select
                value={ownershipScope}
                onValueChange={(value) =>
                  setOwnershipScope(
                    z
                      .enum(["PERSONAL", "ORG_OPERATIONS", "ORG_BILLING"])
                      .parse(value),
                  )
                }
              >
                <SelectTrigger id="new-case-owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PERSONAL">Me</SelectItem>
                  {canOwnOperations && (
                    <SelectItem value="ORG_OPERATIONS">
                      Organization operations team
                    </SelectItem>
                  )}
                  {canOwnBilling && (
                    <SelectItem value="ORG_BILLING">
                      Organization billing team
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="new-ticket-issueType">
              What&apos;s this about? <span className="text-red-500">*</span>
            </Label>
            <Select value={issueType} onValueChange={setIssueType}>
              <SelectTrigger id="new-ticket-issueType">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PLATFORM_ISSUE_TYPE_CATEGORIES).map(
                  ([category, types]) => (
                    <SelectGroup key={category}>
                      {/* Group + label associate the heading with its options
                          for assistive technology, unlike styled divs. */}
                      <SelectLabel className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {category}
                      </SelectLabel>
                      {types.map((t) => (
                        <SelectItem key={t} value={t}>
                          {ISSUE_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-ticket-title">
              Subject <span className="text-red-500">*</span>
            </Label>
            <Input
              id="new-ticket-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="One line summarising the problem"
              maxLength={200}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-ticket-description">
              Details <span className="text-red-500">*</span>
            </Label>
            <Textarea
              id="new-ticket-description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened, what you expected, and anything you already tried."
              maxLength={4000}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-ticket-priority">Priority</Label>
            <Select
              value={priority}
              onValueChange={(v) => {
                const nextPriority = PRIORITY_BY_VALUE[v] ?? "MEDIUM";
                setPriority(nextPriority);
                setCallbackRequested(
                  nextPriority === "HIGH" || nextPriority === "URGENT",
                );
              }}
            >
              <SelectTrigger id="new-ticket-priority">
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

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={callbackRequested}
                onChange={(e) => setCallbackRequested(e.target.checked)}
              />
              <span>Request urgent phone callback</span>
            </label>
            {callbackRequested && (
              <>
                <Input
                  id="new-ticket-callback-phone"
                  type="tel"
                  aria-label="Callback phone number"
                  aria-invalid={phoneError ? true : undefined}
                  aria-describedby={
                    phoneError ? "new-ticket-callback-phone-error" : undefined
                  }
                  value={callbackPhone}
                  onChange={(e) => {
                    setCallbackPhone(e.target.value);
                    setPhoneError(null);
                  }}
                  placeholder="+91 98765 43210"
                  maxLength={32}
                />
                {phoneError && (
                  <p
                    id="new-ticket-callback-phone-error"
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {phoneError}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !valid ||
                create.isPending ||
                (callbackRequested && !callbackPhone.trim())
              }
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create request"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
