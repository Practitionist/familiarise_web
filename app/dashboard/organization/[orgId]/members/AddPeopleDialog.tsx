"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import type { MemberRole } from "@prisma/client";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { FieldError } from "@/components/ui/field-error";
import { useToast } from "@/hooks/use-toast";
import {
  errorMessageFromBody,
  validateOutboundPayload,
} from "@/lib/fetch-helpers";
import { humanizeOrgError } from "@/lib/labels/org-errors";
import { MEMBER_ROLE_LABEL, getInvitableRoles } from "@/lib/labels/org-labels";
import {
  AddMemberPayloadSchema,
  CreateInvitationPayloadSchema,
} from "@/schemas/organizations";

type InvitableRole = z.infer<typeof CreateInvitationPayloadSchema>["role"];

type Outcome = "added" | "invited";

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function throwFrom(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => null);
  throw new Error(humanizeOrgError(errorMessageFromBody(body, fallback)));
}

/**
 * Add an existing account straight away; anyone without one gets an email
 * invitation instead. Both APIs already existed behind two buttons that asked
 * the operator to know which case they were in (#1527 "Add people").
 */
async function addPerson(
  orgId: string,
  payload: { email: string; role: InvitableRole },
): Promise<Outcome> {
  const added = await postJson(
    `/api/organizations/${orgId}/members`,
    validateOutboundPayload(AddMemberPayloadSchema, payload),
  );
  if (added.ok) return "added";
  const body = await added
    .clone()
    .json()
    .catch(() => null);
  if (added.status !== 404 || body?.error !== "USER_NOT_FOUND") {
    return throwFrom(added, "Couldn't add this person.");
  }
  const invited = await postJson(
    `/api/organizations/${orgId}/invitations`,
    validateOutboundPayload(CreateInvitationPayloadSchema, payload),
  );
  if (!invited.ok) return throwFrom(invited, "Couldn't send the invitation.");
  return "invited";
}

export function AddPeopleDialog({
  orgId,
  canSponsor,
  canHost,
  disabledReason,
}: Readonly<{
  orgId: string;
  canSponsor: boolean;
  canHost: boolean;
  /** Set when the org can't take new people yet; disables the trigger. */
  disabledReason?: string;
}>) {
  const roleOptions = getInvitableRoles(canSponsor, canHost);
  // Default to the org's common consumer role so the Select is never blank.
  let defaultRole: MemberRole = "MANAGER";
  if (canSponsor) defaultRole = "LEARNER";
  else if (canHost) defaultRole = "EXPERT";

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>(defaultRole);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () =>
      addPerson(orgId, { email: email.trim(), role: role as InvitableRole }),
    onSuccess: (outcome) => {
      void queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      void queryClient.invalidateQueries({
        queryKey: ["org-invitations", orgId],
      });
      toast({
        title: outcome === "added" ? "Added" : "Invitation sent",
        description:
          outcome === "added"
            ? `${email.trim()} is now a member.`
            : `${email.trim()} has no account yet, so we emailed them an invitation.`,
      });
      setOpen(false);
      setEmail("");
      setRole(defaultRole);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={disabledReason !== undefined}
        title={disabledReason}
      >
        <UserPlus className="mr-1 h-4 w-4" /> Add people
      </Button>
      <ResponsiveModal open={open} onOpenChange={setOpen}>
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Add people</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              Someone who already has a Familiarise account joins straight away.
              Anyone else gets an email invitation to create one.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-people-email">Email</Label>
              <Input
                id="add-people-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-people-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as MemberRole)}
              >
                <SelectTrigger id="add-people-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((value) => (
                    <SelectItem key={value} value={value}>
                      {MEMBER_ROLE_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FieldError message={error} />
          </div>
          <ResponsiveModalFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !email.includes("@")}
            >
              {mutation.isPending ? "Adding…" : "Add"}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
