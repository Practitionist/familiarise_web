"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Trash2, Pencil } from "lucide-react";

import type { MemberRole, MemberStatus } from "@prisma/client";
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  MEMBER_ROLE_LABEL,
  MEMBER_STATUS_LABEL,
} from "@/lib/labels/org-labels";
import {
  AddMemberPayloadSchema,
  MembersListResponseSchema,
  UpdateMemberPayloadSchema,
  type MemberRow,
} from "@/schemas/organizations";
import {
  parseJsonResponse,
  validateOutboundPayload,
  errorMessageFromBody,
} from "@/lib/fetch-helpers";
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

// `MemberRow` (and the response shape) live in `@/schemas/organizations`
// so the dashboard and any other consumer (e.g. operator tools) share the
// same runtime contract.

const SELECTABLE_ROLES: Array<{ value: MemberRole; label: string }> = [
  { value: "OWNER", label: "Owner" },
  { value: "MAINTAINER", label: "Maintainer" },
  { value: "MANAGER", label: "Manager" },
  { value: "LEARNER", label: "Learner" },
];

async function fetchMembers(orgId: string): Promise<{ members: MemberRow[] }> {
  const res = await fetch(`/api/organizations/${orgId}/members`);
  const parsed = await parseJsonResponse(
    res,
    MembersListResponseSchema,
    "Failed to load members",
  );
  return { members: parsed.data };
}

async function addMember(
  orgId: string,
  payload: { email: string; role: MemberRole },
) {
  // The server's `POST /members` only accepts the self-service subset
  // (OWNER/MAINTAINER/MANAGER/LEARNER) — the schema enforces that union
  // before we even open the connection.
  const validated = validateOutboundPayload(AddMemberPayloadSchema, payload);
  const res = await fetch(`/api/organizations/${orgId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validated),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessageFromBody(body, "Failed to add member"));
  return body;
}

async function updateMember(
  orgId: string,
  memberId: string,
  payload: { role?: MemberRole; status?: MemberStatus },
) {
  // Schema enforces "at least one of role or status" so an empty PATCH
  // never leaves the client (would 400 on the server anyway).
  const validated = validateOutboundPayload(
    UpdateMemberPayloadSchema,
    payload,
  );
  const res = await fetch(
    `/api/organizations/${orgId}/members/${memberId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validated),
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessageFromBody(body, "Failed to update member"));
  return body;
}

async function removeMember(orgId: string, memberId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/members/${memberId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(errorMessageFromBody(body, "Failed to remove member"));
  }
}

export function MembersPageClient({ orgId }: { orgId: string }) {
  const { isAtLeast } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, { minRole: "MANAGER" });
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => fetchMembers(orgId),
    enabled: allowed,
  });

  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("LEARNER");
  const [error, setError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: () => addMember(orgId, { email: email.trim(), role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setShowInvite(false);
      setEmail("");
      setRole("LEARNER");
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  // Destructive removals are gated through a confirm dialog rather than
  // the raw browser confirm() because (a) it matches the rest of the
  // dashboard styling, and (b) it gives us room to show the target
  // member's name + email so the user can't mis-click on the wrong row.
  const [memberToRemove, setMemberToRemove] = useState<MemberRow | null>(null);

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => removeMember(orgId, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setMemberToRemove(null);
    },
  });

  // Edit member state. We narrow to the MemberRole / MemberStatus unions
  // so the Select onValueChange handlers can't push a typo into the
  // outbound payload — the schema would reject it but this catches it
  // at compile time.
  const [editMember, setEditMember] = useState<MemberRow | null>(null);
  const [editRole, setEditRole] = useState<MemberRole>("LEARNER");
  const [editStatus, setEditStatus] = useState<MemberStatus>("ACTIVE");
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = (m: MemberRow) => {
    setEditMember(m);
    setEditRole(m.role);
    setEditStatus(m.status as MemberStatus);
    setEditError(null);
  };

  const editMutation = useMutation({
    mutationFn: () =>
      updateMember(orgId, editMember!.id, {
        role: editRole,
        status: editStatus,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setEditMember(null);
      setEditError(null);
    },
    onError: (err: Error) => setEditError(err.message),
  });

  if (!allowed) return null;

  return (
    <>
      <DashboardHeader
        title="Members"
        subtitle="Everyone with a seat in this organization"
        actions={
          isAtLeast("MAINTAINER") && (
            <Button size="sm" onClick={() => setShowInvite(true)}>
              <UserPlus className="h-4 w-4 mr-1" /> Add member
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
                : `${data?.members.length ?? 0} members`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    {isAtLeast("MAINTAINER") && (
                      <TableHead className="w-24">Actions</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.members.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-zinc-900">
                            {m.user.name ?? "—"}
                          </span>
                          <span className="text-xs text-zinc-500">
                            {m.user.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {MEMBER_ROLE_LABEL[m.role as MemberRole] ?? m.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            m.status === "ACTIVE" ? "default" : "outline"
                          }
                        >
                          {MEMBER_STATUS_LABEL[m.status as MemberStatus] ??
                            m.status}
                        </Badge>
                      </TableCell>
                      {isAtLeast("MAINTAINER") && (
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Edit member"
                              onClick={() => openEdit(m)}
                            >
                              <Pencil className="h-4 w-4 text-zinc-500" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Remove member"
                              onClick={() => setMemberToRemove(m)}
                              disabled={removeMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  {data && data.members.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-sm text-zinc-500 py-6"
                      >
                        No members yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      <Dialog open={showInvite} onOpenChange={setShowInvite}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add member</DialogTitle>
            <DialogDescription>
              The user must already have a Familiarise account. To invite a
              brand-new email, use the Invitations page.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-email">Email</Label>
              <Input
                id="add-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as MemberRole)}
              >
                <SelectTrigger id="add-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELECTABLE_ROLES.map((r) => (
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
            <Button
              variant="outline"
              onClick={() => setShowInvite(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !email.includes("@")}
            >
              {addMutation.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit member dialog */}
      <Dialog open={!!editMember} onOpenChange={(open) => !open && setEditMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit member</DialogTitle>
            <DialogDescription>
              {editMember?.user.name ?? editMember?.user.email}
              {editMember?.role === "LEARNER" && editRole !== "LEARNER" && (
                <span className="block mt-1 text-amber-600 text-xs">
                  Changing from Learner will release their seat.
                </span>
              )}
              {editMember?.role !== "LEARNER" && editRole === "LEARNER" && (
                <span className="block mt-1 text-amber-600 text-xs">
                  Changing to Learner will consume a seat.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select
                value={editRole}
                onValueChange={(v) => setEditRole(v as MemberRole)}
              >
                <SelectTrigger id="edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELECTABLE_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-status">Status</Label>
              <Select
                value={editStatus}
                onValueChange={(v) => setEditStatus(v as MemberStatus)}
              >
                <SelectTrigger id="edit-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="SUSPENDED">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editError && <p className="text-sm text-red-600">{editError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditMember(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => editMutation.mutate()}
              disabled={editMutation.isPending}
            >
              {editMutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove-member confirm dialog. Styled to match the rest of the
          dashboard instead of using window.confirm() so the user sees
          which row they're about to destroy. */}
      <Dialog
        open={!!memberToRemove}
        onOpenChange={(open) => !open && setMemberToRemove(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove member?</DialogTitle>
            <DialogDescription>
              {memberToRemove?.user.name ?? memberToRemove?.user.email}
              {" "}
              will lose access to this organization immediately. You can
              re-invite them later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMemberToRemove(null)}
              disabled={removeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                memberToRemove && removeMutation.mutate(memberToRemove.id)
              }
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? "Removing…" : "Remove member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
