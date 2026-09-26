"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Copy } from "lucide-react";
import type { MemberRole } from "@prisma/client";
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import { MEMBER_ROLE_LABEL } from "@/lib/labels/org-labels";
import {
  InvitationsListResponseSchema,
  type InvitationRow,
} from "@/schemas/organizations";
import { parseJsonResponse, errorMessageFromBody } from "@/lib/fetch-helpers";
import type { Tone } from "@/lib/ui/tone";

// Invitation.status is stored as a free-form string to stay aligned with
// BetterAuth's `member_invitations` bridge table. The three states the
// dashboard emits are lower-case; keep the label map scoped to those
// and fall back to the raw value for anything we don't recognise.
const INVITATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "caution" },
  accepted: { label: "Accepted", tone: "success" },
  revoked: { label: "Revoked", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { AddPeopleDialog } from "./AddPeopleDialog";
import { BulkImportDialog } from "./BulkImportDialog";

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

export function MemberInvitationsPanel({ orgId }: { orgId: string }) {
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "invitations.manage",
  });
  const { canSponsor, canHost } = useOrgRole(orgId);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-invitations", orgId],
    queryFn: () => fetchInvitations(orgId),
    // Don't fire the fetch until we know the caller passes the MAINTAINER
    // gate — otherwise non-privileged users who deep-link here get a 403
    // in the network tab before the redirect kicks in.
    enabled: allowed,
  });

  // Confirm-before-revoke so a mis-click doesn't nuke a pending invite
  // and force the user to re-send it. Using the same dialog primitives
  // as the rest of the dashboard rather than window.confirm() keeps the
  // styling consistent and shows which email is about to be revoked.
  const [invToRevoke, setInvToRevoke] = useState<InvitationRow | null>(null);

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

  const columns: ResponsiveColumn<InvitationRow>[] = [
    {
      key: "email",
      header: "Email",
      primary: true,
      cell: (inv) => inv.email,
    },
    {
      key: "role",
      header: "Role",
      cell: (inv) => (
        <Badge variant="secondary">
          {MEMBER_ROLE_LABEL[inv.role as MemberRole] ?? inv.role}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (inv) => (
        <StatusBadge
          label={INVITATION_STATUS[inv.status]?.label ?? inv.status}
          tone={INVITATION_STATUS[inv.status]?.tone ?? "neutral"}
        />
      ),
    },
    {
      key: "expires",
      header: "Expires",
      className: "text-xs text-muted-foreground",
      cell: (inv) => new Date(inv.expiresAt).toLocaleDateString(),
    },
  ];

  const renderRowActions = (inv: InvitationRow) => (
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
  );

  return (
    <>
      <PanelHeader
        description="Pending invitations to join this organization"
        actions={
          <div className="flex flex-wrap gap-2">
            {/* #1527 Q6 — learners only, so sponsor orgs only. */}
            {canSponsor && <BulkImportDialog orgId={orgId} />}
            <AddPeopleDialog
              orgId={orgId}
              canSponsor={canSponsor}
              canHost={canHost}
            />
          </div>
        }
      />
      <div className="space-y-6">
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
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <ResponsiveTable<InvitationRow>
                columns={columns}
                rows={data?.invitations ?? []}
                getRowId={(inv) => inv.id}
                rowActions={renderRowActions}
                empty={
                  <p className="text-center text-sm text-muted-foreground py-6">
                    No pending invitations.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>
      </div>

      <ResponsiveModal
        open={!!invToRevoke}
        onOpenChange={(open) => !open && setInvToRevoke(null)}
      >
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Revoke invitation?</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {invToRevoke?.email} will no longer be able to use their invite
              link. You can send a fresh invitation at any time.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <ResponsiveModalFooter>
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
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
