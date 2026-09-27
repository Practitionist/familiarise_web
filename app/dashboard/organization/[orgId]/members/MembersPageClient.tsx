"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Trash2, Pencil, Users } from "lucide-react";

import type { MemberRole, MemberStatus } from "@prisma/client";
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  MEMBER_ROLE_LABEL,
  MEMBER_STATUS_LABEL,
  MEMBER_STATUS_TONE,
  getInvitableRoles,
} from "@/lib/labels/org-labels";
import {
  MEMBER_LIST_STATUSES,
  MembersListResponseSchema,
  UpdateMemberPayloadSchema,
  membersListKey,
  membersListQueryFromUrl,
  type MemberRow,
  type MembersListQuery,
  type MembersListResult,
} from "@/schemas/organizations";
import {
  parseJsonResponse,
  validateOutboundPayload,
  errorMessageFromBody,
} from "@/lib/fetch-helpers";
import { humanizeOrgError } from "@/lib/labels/org-errors";
import { isBlockedRoleTransition } from "@/lib/enterprise/role-transitions";
import { useSession } from "@/lib/auth-client";
import { useListParams } from "@/hooks/useListParams";
import { displayedScore } from "@/lib/reviews-display";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
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
import { AddPeopleDialog } from "./AddPeopleDialog";

// `MemberRow` (and the response shape) live in `@/schemas/organizations`
// so the dashboard and any other consumer (e.g. operator tools) share the
// same runtime contract.

// Capability-aware role list. EXPERT only appears on canHost orgs; LEARNER
// only on canSponsor orgs. Server enforces the symmetric gates
// (EXPERT_REQUIRES_CANHOST + LEARNER_REQUIRES_CANSPONSOR).
function selectableRoles(
  viewerRole: MemberRole,
  canSponsor: boolean,
  canHost: boolean,
): Array<{ value: MemberRole; label: string }> {
  return getInvitableRoles(viewerRole, canSponsor, canHost).map((value) => ({
    value,
    label: MEMBER_ROLE_LABEL[value],
  }));
}

// #1527 — chip order; a role only gets a chip while it has members.
/** #1851 decision 6 — roles only an OWNER grants or takes away. */
const OWNER_ONLY_ROLES: ReadonlySet<MemberRole> = new Set([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
]);

const ROLE_CHIPS: MemberRole[] = [
  "OWNER",
  "MAINTAINER",
  "MANAGER",
  "SUPPORT",
  "BILLING_ADMIN",
  "EXPERT",
  "LEARNER",
];
const ALL_ROLES = "ALL";
const FILTER_KEYS = ["role", "status"] as const;
const DEFAULT_SORT = { key: "name", dir: "asc" } as const;
const STATUS_OPTIONS = MEMBER_LIST_STATUSES.map((value) => ({
  value,
  label: MEMBER_STATUS_LABEL[value],
}));

const PAYOUT_LABEL = { SELF: "Paid to self", ORGANIZATION: "Paid to org" };

/** #1527 — what the retired Experts tab showed, under an EXPERT's name. */
function ExpertLine({ member }: Readonly<{ member: MemberRow }>) {
  const profile = member.consultantProfile;
  // The published 1:1 score or nothing; null means not enough rated sessions.
  const score = profile ? displayedScore(profile).score : null;
  const parts = [
    profile?.headline,
    score === null
      ? null
      : `★ ${score.toFixed(1)} (${profile?.ratedClientsOneToOne ?? 0})`,
    member.payoutRecipient && PAYOUT_LABEL[member.payoutRecipient],
  ].filter(Boolean);
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      {parts.length > 0 && (
        <span className="max-w-xs truncate">{parts.join(" · ")}</span>
      )}
      <StatusBadge
        size="sm"
        label={profile?.isVerified ? "Verified" : "Unverified"}
        tone={profile?.isVerified ? "success" : "neutral"}
      />
    </span>
  );
}

async function fetchMembers(
  orgId: string,
  query: MembersListQuery,
): Promise<MembersListResult> {
  const sp = new URLSearchParams({
    sort: query.sort,
    dir: query.dir,
    page: String(query.page),
    perPage: String(query.perPage),
  });
  if (query.q) sp.set("q", query.q);
  if (query.role) sp.set("role", query.role.join(","));
  if (query.status) sp.set("status", query.status.join(","));
  const res = await fetch(
    `/api/organizations/${orgId}/members?${sp.toString()}`,
  );
  const parsed = await parseJsonResponse(
    res,
    MembersListResponseSchema,
    "Failed to load members",
  );
  return {
    members: parsed.data,
    total: parsed.meta?.total ?? parsed.data.length,
    counts: parsed.counts ?? {},
  };
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
  const validated = validateOutboundPayload(UpdateMemberPayloadSchema, payload);
  const res = await fetch(`/api/organizations/${orgId}/members/${memberId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validated),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Zod field-level surfacing. The server returns `error: "Invalid body"`
    // for any schema parse failure, with the offending field names in
    // `detail.fieldErrors`. Showing the field name turns an opaque
    // "Invalid body" toast into something a user can actually act on
    // ("we don't recognize that role — refresh and try again"). Surfaced
    // when MAINTAINER→BILLING_ADMIN promotion failed because the PATCH
    // route's local Zod role enum was stale relative to the Prisma enum.
    const fieldErrors = body?.detail?.fieldErrors as
      | Record<string, string[] | undefined>
      | undefined;
    if (fieldErrors) {
      const offending = Object.keys(fieldErrors).filter(
        (k) => fieldErrors[k]?.length,
      );
      if (offending.length > 0) {
        throw new Error(
          `Couldn't save changes — invalid ${offending.join(", ")}. ` +
            `Refresh the page and try again, or contact support if this persists.`,
        );
      }
    }
    const raw = errorMessageFromBody(body, "Failed to update member");
    throw new Error(humanizeOrgError(raw));
  }
  return body;
}

async function removeMember(orgId: string, memberId: string) {
  const res = await fetch(`/api/organizations/${orgId}/members/${memberId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const raw = errorMessageFromBody(body, "Failed to remove member");
    throw new Error(humanizeOrgError(raw));
  }
}

export function MembersPageClient({ orgId }: { orgId: string }) {
  // canSponsor/canHost drive the capability-aware role options (LEARNER
  // requires canSponsor, EXPERT requires canHost — symmetric server gates).
  const {
    role: viewerRole,
    isAtLeast,
    can,
    canSponsor,
    canHost,
  } = useOrgRole(orgId);
  const { data: session } = useSession();
  // Compare by email — BetterAuth's session.user.id can be the BetterAuth
  // internal id rather than the Familiarise `User.id` mirrored on
  // `MemberRow.user.id`, so a literal id-equality check missed the
  // self-row case. Email is invariant across both stores (set via
  // emailVerified flow), so it's the reliable self-detection key.
  const viewerEmail = session?.user?.email?.toLowerCase();
  const isOwnRow = (m: { user: { email: string } }) =>
    viewerEmail !== undefined && m.user.email.toLowerCase() === viewerEmail;
  // #777 FDE Group B P1 — operator read floor (OWNER/MAINTAINER/MANAGER/
  // SUPPORT). SUPPORT gets the roster READ-ONLY for ticket investigation,
  // so the sidebar Members entry isn't a dead redirect. Mutation controls
  // below are members.manage (OWNER/MAINTAINER), the routes' own grant.
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "members.read",
  });
  const queryClient = useQueryClient();
  const roleOptions = selectableRoles(viewerRole, canSponsor, canHost);
  // #1527 — role, status, search, sort and page all live in the URL.
  const list = useListParams({
    filterKeys: FILTER_KEYS,
    defaultSort: DEFAULT_SORT,
  });
  const searchParams = useSearchParams();
  const query = useMemo(
    () => membersListQueryFromUrl((key) => searchParams.get(key)),
    [searchParams],
  );

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: membersListKey(orgId, query),
    queryFn: () => fetchMembers(orgId, query),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });

  const counts = data?.counts ?? {};
  const pickedRole = query.role?.length === 1 ? query.role[0] : undefined;
  const roleChips = [
    {
      value: ALL_ROLES,
      label: "All",
      count: data
        ? Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)
        : undefined,
    },
    ...ROLE_CHIPS.filter((r) => (counts[r] ?? 0) > 0 || r === pickedRole).map(
      (r) => ({ value: r, label: MEMBER_ROLE_LABEL[r], count: counts[r] ?? 0 }),
    ),
  ];
  const isFiltered = Boolean(
    query.q || query.role || list.filters.status !== null,
  );
  const clearFilters = () =>
    list.setParams({ q: "", filters: { role: null, status: null } });

  // Destructive removals are gated through a confirm dialog rather than
  // the raw browser confirm() because (a) it matches the rest of the
  // dashboard styling, and (b) it gives us room to show the target
  // member's name + email so the user can't mis-click on the wrong row.
  const [memberToRemove, setMemberToRemove] = useState<MemberRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => removeMember(orgId, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setMemberToRemove(null);
      setRemoveError(null);
    },
    onError: (err: Error) => setRemoveError(err.message),
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
    setEditPayoutRecipient(m.payoutRecipient ?? "SELF");
    setEditError(null);
  };

  const editMutation = useMutation({
    mutationFn: () =>
      updateMember(orgId, editMember!.id, {
        role: editRole,
        status: editStatus,
        // #729 — only an EXPERT's payout routing is meaningful; the server
        // ignores it for other roles anyway. Never sent unless it was read.
        ...(editRole === "EXPERT" &&
          canSetPayout && {
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

  const canManage = can("members.manage");
  // #1851 decision 5 — payout routing is finance-only (OWNER, BILLING_ADMIN);
  // MAINTAINER still sees it. The server omits it without `payouts.read`.
  const canSetPayout =
    can("payouts.manage") && editMember?.payoutRecipient !== undefined;
  // #1851 decision 6 — only an OWNER grants or removes these roles.
  const ownerOnly = (r: MemberRole) =>
    OWNER_ONLY_ROLES.has(r) && !isAtLeast("OWNER");
  const removeBlockedReason = (m: MemberRow): string | undefined => {
    if (isOwnRow(m)) return "You cannot remove yourself";
    if (ownerOnly(m.role)) {
      return "Only an Owner can remove an Owner, Maintainer or Billing admin";
    }
    return undefined;
  };

  const columns: ResponsiveColumn<MemberRow>[] = [
    {
      key: "name",
      header: "Member",
      primary: true,
      sortable: true,
      cell: (m) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">
            {m.user.name ?? "—"}
          </span>
          <span className="text-xs text-muted-foreground">{m.user.email}</span>
          {m.role === "EXPERT" && <ExpertLine member={m} />}
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      sortable: true,
      cell: (m) => <StatusBadge label={MEMBER_ROLE_LABEL[m.role]} />,
    },
    {
      key: "status",
      header: "Status",
      cell: (m) => (
        <StatusBadge
          label={MEMBER_STATUS_LABEL[m.status]}
          tone={MEMBER_STATUS_TONE[m.status]}
        />
      ),
    },
    {
      key: "joined",
      header: "Joined",
      sortable: true,
      cell: (m) => (
        <span className="text-xs text-muted-foreground">
          {new Date(m.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  const renderRowActions = (m: MemberRow) => (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Edit member"
        onClick={() => openEdit(m)}
      >
        <Pencil className="h-4 w-4 text-muted-foreground" />
      </Button>
      {/* Trash is disabled in two cases:
           1. Self-delete — a MAINTAINER clicking their
              own trash would self-fire and need another
              OWNER to restore them. "Leave org" belongs
              to a dedicated confirmation flow.
           2. Non-OWNER removing an OWNER — same gate as
              PATCH role-change, since deletion is
              functionally identical to revoking the
              OWNER role.
           Both rules are also enforced server-side as
           defense-in-depth. The wrapping <span> exists
           to surface the `title` tooltip — browsers
           don't fire mouseover events on disabled
           <button> elements, so a title on the button
           itself is silently dropped. The span owns
           the title and receives hover regardless. */}
      <span title={removeBlockedReason(m)} className="inline-flex">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Remove member"
          onClick={() => setMemberToRemove(m)}
          disabled={
            removeMutation.isPending || isOwnRow(m) || ownerOnly(m.role)
          }
        >
          <Trash2 className="h-4 w-4 text-red-500" />
        </Button>
      </span>
    </div>
  );

  return (
    <>
      <PanelHeader
        description="Everyone with a seat in this organization"
        actions={
          canManage && (
            <AddPeopleDialog
              orgId={orgId}
              canSponsor={canSponsor}
              canHost={canHost}
            />
          )
        }
      />
      <ResponsiveTable<MemberRow>
        columns={columns}
        rows={data?.members ?? []}
        getRowId={(m) => m.id}
        rowActions={canManage ? renderRowActions : undefined}
        isLoading={isLoading && !data}
        error={isError ? "Couldn't load members." : undefined}
        onRetry={() => void refetch()}
        sort={{ key: query.sort, dir: query.dir }}
        onSortChange={list.setSort}
        toolbar={
          <FilterBar
            search={{
              label: "Search members by name or email",
              placeholder: "Search name or email",
              value: query.q ?? "",
              onChange: list.setQ,
            }}
            chips={{
              label: "Role",
              options: roleChips,
              value: pickedRole ?? (query.role ? null : ALL_ROLES),
              onChange: (value) =>
                list.setFilter("role", value === ALL_ROLES ? null : value),
            }}
            selects={[
              {
                key: "status",
                label: "Status",
                value: query.status?.[0] ?? "ACTIVE",
                options: STATUS_OPTIONS,
                // Active is the default, so it stays out of the URL.
                onChange: (value) =>
                  list.setFilter("status", value === "ACTIVE" ? null : value),
              },
            ]}
            onClear={clearFilters}
            canClear={isFiltered}
          />
        }
        empty={
          isFiltered ? (
            <EmptyState
              icon={Users}
              title="No members match these filters"
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={Users} title="No members yet" />
          )
        }
      />
      {data && data.total > 0 && (
        <TablePagination
          page={query.page}
          pageSize={query.perPage}
          total={data.total}
          onPageChange={list.setPage}
        />
      )}

      {/* Edit member dialog */}
      <ResponsiveModal
        open={!!editMember}
        onOpenChange={(open) => !open && setEditMember(null)}
      >
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Edit member</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {editMember?.user.name ?? editMember?.user.email}
              {editMember?.role !== "LEARNER" && editRole === "LEARNER" && (
                <span className="block mt-1 text-amber-600 text-xs">
                  Changing to Learner will consume a seat.
                </span>
              )}
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              {/* Role dropdown is disabled when editing your own row.
                  The server's PATCH route rejects self-role-changes with
                  403 ("ask another operator to do it") — the rule lives
                  there because role transitions belong to a peer-or-
                  superior review path. UI mirrors so the dropdown isn't
                  a footgun: a MAINTAINER could otherwise self-demote to
                  LEARNER (lose admin) or to EXPERT (lazy-creates a
                  ConsultantProfile, bypassing #729's strict identity
                  gate that POST enforces). Status-only self-edits stay
                  allowed; only role changes are blocked. */}
              <Select
                value={editRole}
                onValueChange={(v) => setEditRole(v as MemberRole)}
                disabled={editMember !== null && isOwnRow(editMember)}
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
              {editMember !== null && isOwnRow(editMember) && (
                <p className="text-xs text-muted-foreground">
                  You cannot change your own role. Ask another operator to do it
                  for you.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-status">Status</Label>
              {/* #1846 — nobody changes their own status either; the last
                  OWNER suspending themselves locked the org out. */}
              <Select
                value={editStatus}
                onValueChange={(v) => setEditStatus(v as MemberStatus)}
                disabled={editMember !== null && isOwnRow(editMember)}
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
            {editRole === "EXPERT" && canSetPayout && (
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
                  Where this expert&apos;s share of org-hosted sessions is
                  routed.
                </p>
              </div>
            )}
            {editMember &&
              isBlockedRoleTransition(editMember.role, editRole) && (
                <p className="text-sm text-red-600">
                  Members cannot switch between Learner and Expert roles. Remove
                  the member and re-invite them with the new role instead.
                </p>
              )}
            {editMember &&
              (ownerOnly(editMember.role) || ownerOnly(editRole)) && (
                <p className="text-sm text-red-600">
                  Only an Owner can grant or remove the Owner, Maintainer or
                  Billing admin role.
                </p>
              )}
            {editError && <p className="text-sm text-red-600">{editError}</p>}
          </div>
          <ResponsiveModalFooter>
            <Button variant="outline" onClick={() => setEditMember(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => editMutation.mutate()}
              disabled={
                editMutation.isPending ||
                (editMember !== null &&
                  (isBlockedRoleTransition(editMember.role, editRole) ||
                    ownerOnly(editMember.role) ||
                    ownerOnly(editRole)))
              }
            >
              {editMutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Remove-member confirm dialog. Styled to match the rest of the
          dashboard instead of using window.confirm() so the user sees
          which row they're about to destroy. */}
      <ResponsiveModal
        open={!!memberToRemove}
        onOpenChange={(open) => {
          if (!open) {
            setMemberToRemove(null);
            setRemoveError(null);
          }
        }}
      >
        <ResponsiveModalContent>
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>Remove member?</ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {memberToRemove?.user.name ?? memberToRemove?.user.email} will
              lose access to this organization immediately. You can re-invite
              them later.
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>
          {removeError && <p className="text-sm text-red-600">{removeError}</p>}
          <ResponsiveModalFooter>
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
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
