"use client";

/**
 * #1927 — the Team page client.
 *
 * Lists the ~20 people who can reach the console, plus every invitation in
 * flight, and offers the four actions that change access: invite, revoke a
 * pending invite, suspend, reactivate, force sign-out.
 *
 * ## The 2FA column is the point of this page
 *
 * Not decoration. `lib/auth-helpers.ts` now refuses a staff-or-admin session
 * with `twoFactorEnabled !== true` at 428 `TWO_FACTOR_REQUIRED`, so a console
 * with no 2FA is one that cannot issue a refund. Showing the gap here, on the
 * page an admin already visits, is what makes that requirement actionable
 * instead of a support ticket the first time it fires.
 *
 * ## `can()` is not decoration either
 *
 * The action buttons are gated on `can("users.moderate")` — the same matrix the
 * API enforces — so a staff member reading the roster does not see four
 * buttons that 403. Server-side enforcement is the real gate; this is the
 * honesty half of it.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

/* -------------------------------------------------------------------------- */
/* Wire types — mirror the route's selects exactly                            */
/* -------------------------------------------------------------------------- */

interface OperatorRow {
  id: string;
  name: string | null;
  email: string;
  role: "STAFF" | "ADMIN";
  banned: boolean | null;
  banExpires: string | null;
  twoFactorEnabled: boolean | null;
  onboardingCompleted: boolean | null;
  createdAt: string;
  staffProfile: {
    id: string;
    department: string | null;
    position: string | null;
  } | null;
  adminProfile: { id: string } | null;
  lastSeenAt: string | null;
  activeSessions: number;
}

interface InvitationRow {
  id: string;
  email: string;
  role: "STAFF" | "ADMIN";
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  sentCount: number;
  lastSentAt: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  acceptedUserId: string | null;
  invitedBy: { id: string; name: string | null; email: string } | null;
}

interface TeamResponse {
  operators: OperatorRow[];
  invitations: InvitationRow[];
}

/** Suspension lengths offered. Mirrors the route's 1–365 day cap. */
const SUSPENSION_OPTIONS = [1, 3, 7, 14, 30, 90] as const;

const dateOr = (value: string | null, fallback = "Never") =>
  value ? new Date(value).toLocaleDateString() : fallback;

const timeOr = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Never";

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function TeamPageClient() {
  const { can, viewerId } = useBackofficeCapability();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mayManage = can("users.moderate");

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"STAFF" | "ADMIN">("STAFF");
  const [inviteReason, setInviteReason] = useState("");
  const [inviteResend, setInviteResend] = useState(false);

  const [suspendTarget, setSuspendTarget] = useState<OperatorRow | null>(null);
  const [suspendDays, setSuspendDays] = useState<string>("7");
  const [suspendReason, setSuspendReason] = useState("");

  const [reactivateTarget, setReactivateTarget] = useState<OperatorRow | null>(
    null,
  );
  const [reactivateReason, setReactivateReason] = useState("");

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["team"],
    queryFn: async (): Promise<TeamResponse> => {
      const response = await fetch("/api/admin/staff-invitations");
      if (!response.ok) throw new Error("Failed to load the team roster");
      return response.json();
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["team"] });

  const invite = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/staff-invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail,
          role: inviteRole,
          resend: inviteResend,
          // Required by `withOpsAction`'s schema: every admin action carries a
          // reason, and this one is no exception. It lands in the OpsActionLog.
          reason: inviteReason,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not create that invitation");
      }
      return payload as { invitationId: string; resent: boolean } | null;
    },
    onSuccess: (result) => {
      toast({
        title: result?.resent ? "Invitation resent" : "Invitation sent",
        description: `${inviteEmail} will receive a setup link. It works once, for 72 hours.`,
      });
      setInviteOpen(false);
      setInviteEmail("");
      setInviteReason("");
      setInviteResend(false);
      void invalidate();
    },
    onError: (cause: Error) =>
      toast({
        title: "Could not invite",
        description: cause.message,
        variant: "destructive",
      }),
  });

  const revoke = useMutation({
    mutationFn: async (invitationId: string) => {
      const response = await fetch(
        `/api/admin/staff-invitations/${invitationId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Revoked from the Team page" }),
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not revoke that invitation");
      }
    },
    onSuccess: () => {
      toast({
        title: "Invitation revoked",
        description: "That link can no longer be used.",
      });
      void invalidate();
    },
    onError: (cause: Error) =>
      toast({
        title: "Could not revoke",
        description: cause.message,
        variant: "destructive",
      }),
  });

  const setMemberState = useMutation({
    mutationFn: async (input: {
      userId: string;
      action: "suspend" | "reactivate";
      reason: string;
      suspensionDays?: number;
    }) => {
      const response = await fetch(`/api/admin/team/members/${input.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: input.action,
          reason: input.reason,
          suspensionDays: input.suspensionDays,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "That action could not be completed");
      }
    },
    onSuccess: (_result, input) => {
      toast({
        title:
          input.action === "suspend"
            ? "Operator suspended"
            : "Operator reactivated",
        description:
          input.action === "suspend"
            ? "Every session they had was ended."
            : "They can sign in again.",
      });
      setSuspendTarget(null);
      setSuspendReason("");
      setReactivateTarget(null);
      setReactivateReason("");
      void invalidate();
    },
    onError: (cause: Error) =>
      toast({
        title: "Action failed",
        description: cause.message,
        variant: "destructive",
      }),
  });

  const forceSignOut = useMutation({
    mutationFn: async (userId: string) => {
      // The existing, audited revoke door — not a new one. Deliberate reuse:
      // "end someone's sessions" already has a home with a reason requirement
      // and a surface gate, and a second implementation would be a second
      // place to forget the cross-device signal.
      const response = await fetch(
        `/api/admin/users/${userId}/sessions/revoke`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Force sign-out from the Team page" }),
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        revoked?: number;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not sign them out");
      }
      return payload?.revoked ?? 0;
    },
    onSuccess: (revoked) => {
      toast({
        title: "Signed out everywhere",
        description: `${revoked} session${revoked === 1 ? "" : "s"} ended.`,
      });
      void invalidate();
    },
    onError: (cause: Error) =>
      toast({
        title: "Sign-out failed",
        description: cause.message,
        variant: "destructive",
      }),
  });

  const operators = useMemo(() => data?.operators ?? [], [data]);
  const pendingInvites = useMemo(
    () =>
      (data?.invitations ?? []).filter(
        (invitation) => invitation.status === "PENDING",
      ),
    [data],
  );
  const pastInvites = useMemo(
    () => (data?.invitations ?? []).filter((i) => i.status !== "PENDING"),
    [data],
  );

  const columns: ResponsiveColumn<OperatorRow>[] = [
    {
      key: "person",
      header: "Operator",
      primary: true,
      cell: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {row.name || "Unnamed"}
            {row.id === viewerId ? (
              <span className="ml-2 text-xs text-muted-foreground">(you)</span>
            ) : null}
          </p>
          <p className="text-sm text-muted-foreground">{row.email}</p>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      cell: (row) => row.role,
    },
    {
      key: "status",
      header: "Status",
      cell: (row) =>
        row.banned ? (
          <StatusBadge
            label={row.banExpires ? "Suspended" : "Suspended (no end)"}
            tone="critical"
            variant="dot"
          />
        ) : (
          <StatusBadge label="Active" tone="success" variant="dot" />
        ),
    },
    {
      key: "twofa",
      header: "Two-factor",
      // The column that makes the 428 recoverable: an admin who cannot issue a
      // refund sees why, here, before they try.
      cell: (row) =>
        row.twoFactorEnabled ? (
          <StatusBadge label="Enrolled" tone="success" variant="dot" />
        ) : (
          <StatusBadge label="Not set up" tone="caution" variant="dot" />
        ),
    },
    {
      key: "lastSeen",
      header: "Last seen",
      className: "text-sm text-muted-foreground",
      // Deliberately "last seen", never "active now" — see
      // lib/auth/session-select.ts. Most requests never reach the database, so
      // any claim of liveness would be a guess.
      cell: (row) => timeOr(row.lastSeenAt),
    },
    {
      key: "sessions",
      header: "Sessions",
      cell: (row) =>
        row.activeSessions === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          String(row.activeSessions)
        ),
    },
    ...(mayManage
      ? [
          {
            key: "actions",
            header: "",
            cell: (row: OperatorRow) => (
              <div className="flex flex-wrap justify-end gap-2">
                {!row.banned ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={forceSignOut.isPending}
                      onClick={() => forceSignOut.mutate(row.id)}
                    >
                      Sign out
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={row.id === viewerId}
                      // Self-suspension is refused server-side with a 409 that
                      // says why; disabling it here saves the round trip and the
                      // pointless error toast.
                      title={
                        row.id === viewerId
                          ? "You cannot suspend your own account"
                          : undefined
                      }
                      onClick={() => setSuspendTarget(row)}
                    >
                      Suspend
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setReactivateTarget(row)}
                  >
                    Reactivate
                  </Button>
                )}
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Everyone who can reach this console, and everyone who has been invited to. Staff accounts are created by invitation only — there is no other way in."
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">
            Operators ({operators.length})
          </h2>
          {mayManage ? (
            <Button type="button" size="sm" onClick={() => setInviteOpen(true)}>
              Invite someone
            </Button>
          ) : null}
        </div>
        <ResponsiveTable<OperatorRow>
          columns={columns}
          rows={operators}
          getRowId={(row) => row.id}
          isLoading={isPending && !data}
          error={error && !data ? error : undefined}
          onRetry={() => void refetch()}
          empty={
            <p className="py-10 text-center text-sm text-muted-foreground">
              No operators on this deployment yet.
            </p>
          }
        />
      </section>

      {pendingInvites.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Pending invitations ({pendingInvites.length})
          </h2>
          <ResponsiveTable<InvitationRow>
            columns={invitationColumns(mayManage, revoke.isPending, (id) =>
              revoke.mutate(id),
            )}
            rows={pendingInvites}
            getRowId={(row) => row.id}
            empty={
              <p className="py-6 text-center text-sm text-muted-foreground">
                None.
              </p>
            }
          />
        </section>
      )}

      {pastInvites.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            Invitation history
          </h2>
          <ResponsiveTable<InvitationRow>
            columns={invitationColumns(false, false, () => {})}
            rows={pastInvites}
            getRowId={(row) => row.id}
            empty={
              <p className="py-6 text-center text-sm text-muted-foreground">
                None.
              </p>
            }
          />
        </section>
      )}

      {/* ---------------------------------------------------------------- */}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite an operator</DialogTitle>
            <DialogDescription>
              They receive a single-use link, choose their own password, and are
              asked to set up two-factor authentication before they can use the
              console. Any email address works — a personal one is fine.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="colleague@example.com"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(value) =>
                  setInviteRole(value === "ADMIN" ? "ADMIN" : "STAFF")
                }
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STAFF">
                    Staff — support, tickets, read-only money
                  </SelectItem>
                  <SelectItem value="ADMIN">
                    Administrator — refunds, payouts, accounts
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-reason">
                Reason (recorded in the audit log)
              </Label>
              <Textarea
                id="invite-reason"
                value={inviteReason}
                onChange={(event) => setInviteReason(event.target.value)}
                placeholder="Joining the support team from Monday"
                rows={2}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={inviteResend}
                onChange={(event) => setInviteResend(event.target.checked)}
              />
              Rotate the existing link for this address
            </label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setInviteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                invite.isPending ||
                inviteEmail.trim().length === 0 ||
                inviteReason.trim().length < 5
              }
              onClick={() => invite.mutate()}
            >
              {invite.isPending ? "Sending…" : "Send invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={suspendTarget !== null}
        onOpenChange={(open) => !open && setSuspendTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Suspend {suspendTarget?.name ?? suspendTarget?.email}
            </DialogTitle>
            <DialogDescription>
              Every session they have is ended immediately, and the suspension
              lifts itself when the time is up. This is reversible — you can
              reactivate them from this page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="suspend-days">Length</Label>
              <Select value={suspendDays} onValueChange={setSuspendDays}>
                <SelectTrigger id="suspend-days">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUSPENSION_OPTIONS.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {days} {days === 1 ? "day" : "days"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="suspend-reason">Reason</Label>
              <Textarea
                id="suspend-reason"
                value={suspendReason}
                onChange={(event) => setSuspendReason(event.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSuspendTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                setMemberState.isPending || suspendReason.trim().length < 5
              }
              onClick={() =>
                suspendTarget &&
                setMemberState.mutate({
                  userId: suspendTarget.id,
                  action: "suspend",
                  reason: suspendReason,
                  suspensionDays: Number(suspendDays),
                })
              }
            >
              {setMemberState.isPending ? "Suspending…" : "Suspend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reactivateTarget !== null}
        onOpenChange={(open) => !open && setReactivateTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Reactivate {reactivateTarget?.name ?? reactivateTarget?.email}
            </DialogTitle>
            <DialogDescription>
              Clears the suspension and restores their chat access.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reactivate-reason">Reason</Label>
            <Textarea
              id="reactivate-reason"
              value={reactivateReason}
              onChange={(event) => setReactivateReason(event.target.value)}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReactivateTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                setMemberState.isPending || reactivateReason.trim().length < 5
              }
              onClick={() =>
                reactivateTarget &&
                setMemberState.mutate({
                  userId: reactivateTarget.id,
                  action: "reactivate",
                  reason: reactivateReason,
                })
              }
            >
              {setMemberState.isPending ? "Working…" : "Reactivate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Invitation columns                                                         */
/* -------------------------------------------------------------------------- */

function invitationColumns(
  mayManage: boolean,
  revoking: boolean,
  onRevoke: (id: string) => void,
): ResponsiveColumn<InvitationRow>[] {
  const base: ResponsiveColumn<InvitationRow>[] = [
    {
      key: "email",
      header: "Address",
      primary: true,
      cell: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-foreground">{row.email}</p>
          <p className="text-sm text-muted-foreground">
            invited {dateOr(row.createdAt)}
            {row.invitedBy
              ? ` by ${row.invitedBy.name ?? row.invitedBy.email}`
              : " from the CLI"}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <StatusBadge
          label={invitationStatusLabel(row)}
          tone={invitationStatusTone(row.status)}
          variant="dot"
        />
      ),
    },
    {
      key: "expires",
      header: "Expires",
      className: "text-sm text-muted-foreground",
      cell: (row) =>
        row.status === "PENDING"
          ? dateOr(row.expiresAt)
          : row.status === "ACCEPTED"
            ? dateOr(row.acceptedAt)
            : dateOr(row.revokedAt ?? row.expiresAt),
    },
    {
      key: "sends",
      header: "Sends",
      className: "text-sm text-muted-foreground",
      // Visible because it is the abuse signal: a row sent six times is either
      // a mailbox that is not delivering or someone guessing.
      cell: (row) => String(row.sentCount),
    },
  ];
  if (!mayManage) return base;
  return [
    ...base,
    {
      key: "actions",
      header: "",
      cell: (row: InvitationRow) =>
        row.status === "PENDING" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={revoking}
            onClick={() => onRevoke(row.id)}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];
}

function invitationStatusLabel(row: InvitationRow): string {
  switch (row.status) {
    case "PENDING":
      return "Pending";
    case "ACCEPTED":
      return "Accepted";
    case "REVOKED":
      return "Revoked";
    case "EXPIRED":
      return "Expired";
  }
}

function invitationStatusTone(
  status: InvitationRow["status"],
): "success" | "caution" | "critical" | "neutral" {
  switch (status) {
    case "PENDING":
      return "caution";
    case "ACCEPTED":
      return "success";
    case "REVOKED":
      return "critical";
    case "EXPIRED":
      return "neutral";
  }
}
