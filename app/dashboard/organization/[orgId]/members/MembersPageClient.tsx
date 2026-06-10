"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Trash2, Pencil, Search } from "lucide-react";

import type { MemberRole, MemberStatus } from "@prisma/client";
import { useOrgRole, useRequireOperatorSurface } from "../useOrgRole";
import {
  MEMBER_ROLE_LABEL,
  MEMBER_STATUS_LABEL,
  getInvitableRoles,
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
import { humanizeOrgError } from "@/lib/labels/org-errors";
import { isBlockedRoleTransition } from "@/lib/enterprise/role-transitions";
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

// Capability-aware role list. EXPERT only appears on canHost orgs; LEARNER
// only on canSponsor orgs. Server enforces the symmetric gates
// (EXPERT_REQUIRES_CANHOST + LEARNER_REQUIRES_CANSPONSOR).
function selectableRoles(
  canSponsor: boolean,
  canHost: boolean,
): Array<{ value: MemberRole; label: string }> {
  return getInvitableRoles(canSponsor, canHost).map((value) => ({
    value,
    label: MEMBER_ROLE_LABEL[value],
  }));
}

// #777 §B — q + pagination are passed through to the existing members
// API (it already supports `q` contains-search on name/email and returns
// meta {total,page,perPage}).
async function fetchMembers(
  orgId: string,
  opts: { q?: string; page: number; perPage: number },
): Promise<{ members: MemberRow[]; total: number }> {
  const sp = new URLSearchParams();
  if (opts.q) sp.set("q", opts.q);
  sp.set("page", String(opts.page));
  sp.set("perPage", String(opts.perPage));
  const res = await fetch(`/api/organizations/${orgId}/members?${sp.toString()}`);
  const parsed = await parseJsonResponse(
    res,
    MembersListResponseSchema,
    "Failed to load members",
  );
  return { members: parsed.data, total: parsed.meta?.total ?? parsed.data.length };
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
  if (!res.ok) {
    const raw = errorMessageFromBody(body, "Failed to add member");
    throw new Error(humanizeOrgError(raw));
  }
  return body;
}

async function updateMember(
  orgId: string,
  memberId: string,
  payload: {
    role?: MemberRole;
    status?: MemberStatus;
    payoutRecipient?: "SELF" | "ORGANIZATION";
  },
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
  if (!res.ok) {
    const raw = errorMessageFromBody(body, "Failed to update member");
    throw new Error(humanizeOrgError(raw));
  }
  return body;
}

async function removeMember(orgId: string, memberId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/members/${memberId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const raw = errorMessageFromBody(body, "Failed to remove member");
    throw new Error(humanizeOrgError(raw));
  }
}

export function MembersPageClient({ orgId }: { orgId: string }) {
  // canSponsor/canHost drive the capability-aware role options (LEARNER
  // requires canSponsor, EXPERT requires canHost — symmetric server gates).
  const { isAtLeast, canSponsor, canHost } = useOrgRole(orgId);
  // #777 FDE Group B P1 — operator read floor (OWNER/MAINTAINER/MANAGER/
  // SUPPORT). SUPPORT gets the roster READ-ONLY for ticket investigation,
  // so the sidebar Members entry isn't a dead redirect. Mutation controls
  // below stay MAINTAINER-gated (isAtLeast("MAINTAINER")).
  const { allowed } = useRequireOperatorSurface(orgId);
  const queryClient = useQueryClient();
  const roleOptions = selectableRoles(canSponsor, canHost);
  // Default to the most common consumer role for the org's capability:
  // LEARNER on sponsor-capable orgs, EXPERT on host-only orgs, MANAGER as
  // a last resort. Hard-coding "LEARNER" left the Select trigger blank on
  // host-only orgs because LEARNER was filtered out of roleOptions.
  const defaultRole: MemberRole = canSponsor
    ? "LEARNER"
    : canHost
      ? "EXPERT"
      : "MANAGER";

  // #777 §B — roster search + server pagination. `search` is the live
  // input; `debouncedSearch` is what actually hits the API (250ms) so a
  // fast typist doesn't fire a request per keystroke. Page resets to 1
  // whenever the search term changes.
  const PER_PAGE = 20;
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ["org-members", orgId, debouncedSearch, page],
    queryFn: () =>
      fetchMembers(orgId, {
        q: debouncedSearch || undefined,
        page,
        perPage: PER_PAGE,
      }),
    enabled: allowed,
  });

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));

  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>(defaultRole);
  const [error, setError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: () => addMember(orgId, { email: email.trim(), role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setShowInvite(false);
      setEmail("");
      setRole(defaultRole);
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
  const [editPayoutRecipient, setEditPayoutRecipient] = useState<
    "SELF" | "ORGANIZATION"
  >("SELF");
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = (m: MemberRow) => {
    setEditMember(m);
    setEditRole(m.role);
    setEditStatus(m.status as MemberStatus);
    setEditPayoutRecipient(m.payoutRecipient);
    setEditError(null);
  };

  const editMutation = useMutation({
    mutationFn: () =>
      updateMember(orgId, editMember!.id, {
        role: editRole,
        status: editStatus,
        // #729 — only an EXPERT's payout routing is meaningful; the server
        // ignores it for other roles anyway.
        ...(editRole === "EXPERT" && {
          payoutRecipient: editPayoutRecipient,
        }),
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
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <CardTitle className="text-base">
              {isLoading ? "Loading…" : `${total} members`}
            </CardTitle>
            <div className="relative w-full max-w-xs">
              <Search className="h-4 w-4 absolute left-3 top-2.5 text-zinc-400" />
              <Input
                placeholder="Search name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
                aria-label="Search members"
              />
            </div>
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
                        {debouncedSearch
                          ? "No members match your search."
                          : "No members yet."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}

            {/* Server pagination — meta.total drives the page count. Hidden
                when everything fits on one page. */}
            {!isLoading && pageCount > 1 && (
              <div className="flex items-center justify-between pt-4 text-sm text-zinc-500">
                <span>
                  Page {page} of {pageCount}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
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
                  {roleOptions.map((r) => (
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
            {/* #729 — payout routing, only meaningful for an EXPERT. */}
            {editRole === "EXPERT" && (
              <div className="space-y-2">
                <Label htmlFor="edit-payout">Payout recipient</Label>
                <Select
                  value={editPayoutRecipient}
                  onValueChange={(v) =>
                    setEditPayoutRecipient(v as "SELF" | "ORGANIZATION")
                  }
                >
                  <SelectTrigger id="edit-payout">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SELF">
                      Expert — paid to their own account
                    </SelectItem>
                    <SelectItem value="ORGANIZATION">
                      Organisation — absorbed &amp; distributed internally
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Where this expert&apos;s share of org-hosted sessions is routed.
                </p>
              </div>
            )}
            {editMember &&
              isBlockedRoleTransition(editMember.role, editRole) && (
                <p className="text-sm text-red-600">
                  Members cannot switch between Learner and Expert roles.
                  Remove the member and re-invite them with the new role
                  instead.
                </p>
              )}
            {editError && <p className="text-sm text-red-600">{editError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditMember(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => editMutation.mutate()}
              disabled={
                editMutation.isPending ||
                (editMember !== null &&
                  isBlockedRoleTransition(editMember.role, editRole))
              }
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
