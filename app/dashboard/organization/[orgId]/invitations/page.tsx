"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Trash2, Copy } from "lucide-react";
import type { MemberRole, OrgStatus } from "@prisma/client";
import { useOrgRole, useRequireOrgRole } from "../useOrgRole";
import { MEMBER_ROLE_LABEL, getInvitableRoles } from "@/lib/labels/org-labels";
import { humanizeOrgError } from "@/lib/labels/org-errors";
import {
  fetchOrgDetails,
  orgDetailsQueryKey,
} from "@/lib/api/organizations/org-details";
import {
  CreateInvitationPayloadSchema,
  CreateInvitationResponseSchema,
  InvitationsListResponseSchema,
  type InvitationRow,
} from "@/schemas/organizations";
import {
  parseJsonResponse,
  validateOutboundPayload,
  errorMessageFromBody,
} from "@/lib/fetch-helpers";
import type { z } from "zod";

type SelfServiceRole = z.infer<
  typeof CreateInvitationPayloadSchema
>["role"];

// canHost-aware role list. EXPERT only renders for host-capable orgs;
// sponsor-only orgs see the four self-service roles. Mirrors the
// server's EXPERT_REQUIRES_CANHOST guard in the invitations route.
function selectableRoles(canHost: boolean): Array<{ value: SelfServiceRole; label: string }> {
  return getInvitableRoles(canHost).map((value) => ({
    value: value as SelfServiceRole,
    label: MEMBER_ROLE_LABEL[value],
  }));
}

// Invitation.status is stored as a free-form string to stay aligned with
// BetterAuth's `member_invitations` bridge table. The three states the
// dashboard emits are lower-case; keep the label map scoped to those
// and fall back to the raw value for anything we don't recognise.
const INVITATION_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  revoked: "Revoked",
  expired: "Expired",
};

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// `InvitationRow` lives in `@/schemas/organizations` so the same shape
// powers the wizard, this page, and any future operator tooling.

async function fetchInvitations(
  orgId: string,
): Promise<{ invitations: InvitationRow[] }> {
  const res = await fetch(`/api/organizations/${orgId}/invitations`);
  const parsed = await parseJsonResponse(
    res,
    InvitationsListResponseSchema,
    "Failed to load invitations",
  );
  return { invitations: parsed.data };
}

async function createInvitation(
  orgId: string,
  payload: { email: string; role: SelfServiceRole },
) {
  const validated = validateOutboundPayload(
    CreateInvitationPayloadSchema,
    payload,
  );
  const res = await fetch(`/api/organizations/${orgId}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validated),
  });
  return parseJsonResponse(
    res,
    CreateInvitationResponseSchema,
    "Failed to create invitation",
  );
}

async function revokeInvitation(orgId: string, invitationId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/invitations/${invitationId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errorMessageFromBody(body, "Failed to revoke invitation"));
  }
}

export default function OrgInvitationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { allowed } = useRequireOrgRole(orgId, "MAINTAINER");
  const { canHost } = useOrgRole(orgId);
  const roleOptions = selectableRoles(canHost);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-invitations", orgId],
    queryFn: () => fetchInvitations(orgId),
    // Don't fire the fetch until we know the caller passes the MAINTAINER
    // gate — otherwise non-privileged users who deep-link here get a 403
    // in the network tab before the redirect kicks in.
    enabled: allowed,
  });

  // Read the org the layout already fetched. We pass the same queryKey
  // + queryFn so react-query dedupes: if the layout's fetch has
  // finished (which it always has — the layout blocks child rendering
  // until the cache is warm), we read from the cache; otherwise we
  // kick the same fetch and the layout's call is joined to ours. React
  // Query v5 requires a queryFn even when `enabled` is false, so the
  // previous `enabled: false`-plus-no-queryFn trick crashed on mount.
  const { data: orgSnapshot } = useQuery({
    queryKey: orgDetailsQueryKey(orgId),
    queryFn: () => fetchOrgDetails(orgId),
    enabled: allowed,
    staleTime: 60_000,
  });
  const orgStatus: OrgStatus | undefined = orgSnapshot?.organization.status;
  const isPendingVerification = orgStatus === "PENDING_VERIFICATION";

  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SelfServiceRole>("LEARNER");
  const [error, setError] = useState<string | null>(null);
  // Confirm-before-revoke so a mis-click doesn't nuke a pending invite
  // and force the user to re-send it. Using the same dialog primitives
  // as the rest of the dashboard rather than window.confirm() keeps the
  // styling consistent and shows which email is about to be revoked.
  const [invToRevoke, setInvToRevoke] = useState<InvitationRow | null>(null);

  const createMutation = useMutation({
    mutationFn: () => createInvitation(orgId, { email: email.trim(), role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-invitations", orgId] });
      setShowCreate(false);
      setEmail("");
      setError(null);
    },
    onError: (err: Error) => setError(humanizeOrgError(err.message)),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeInvitation(orgId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-invitations", orgId] });
      setInvToRevoke(null);
    },
  });

  if (!allowed) return null;

  const copyInviteLink = (invitationId: string) => {
    const url = `${window.location.origin}/organizations/invite/${invitationId}`;
    navigator.clipboard.writeText(url);
  };

  return (
    <>
      <DashboardHeader
        title="Invitations"
        subtitle="Pending invitations to join this organization"
        actions={
          isPendingVerification ? (
            // Pre-empt the server's 409 ORG_NOT_VERIFIED — the banner at
            // the top of the dashboard already explains the state, so we
            // just disable the entry point and point back to it on hover.
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button size="sm" disabled aria-disabled="true">
                      <Mail className="h-4 w-4 mr-1" /> Invite by email
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Available after your organization is verified.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Mail className="h-4 w-4 mr-1" /> Invite by email
            </Button>
          )
        }
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isLoading
                ? "Loading…"
                : `${data?.invitations.length ?? 0} invitations`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="w-24">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.invitations.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>{inv.email}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {MEMBER_ROLE_LABEL[inv.role as MemberRole] ??
                            inv.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            inv.status === "pending" ? "default" : "outline"
                          }
                        >
                          {INVITATION_STATUS_LABEL[inv.status] ?? inv.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-500">
                        {new Date(inv.expiresAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Copy invite link"
                            onClick={() => copyInviteLink(inv.id)}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          {inv.status === "pending" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Revoke invitation"
                              onClick={() => setInvToRevoke(inv)}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {data && data.invitations.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-sm text-zinc-500 py-6"
                      >
                        No pending invitations.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send invitation</DialogTitle>
            <DialogDescription>
              The recipient does not need an account yet — they will create
              one when accepting the invite.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inv-email">Email</Label>
              <Input
                id="inv-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as SelfServiceRole)}
              >
                <SelectTrigger id="inv-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !email.includes("@")}
            >
              {createMutation.isPending ? "Sending…" : "Send invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!invToRevoke}
        onOpenChange={(open) => !open && setInvToRevoke(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke invitation?</DialogTitle>
            <DialogDescription>
              {invToRevoke?.email} will no longer be able to use their invite
              link. You can send a fresh invitation at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInvToRevoke(null)}
              disabled={revokeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                invToRevoke && revokeMutation.mutate(invToRevoke.id)
              }
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? "Revoking…" : "Revoke invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
