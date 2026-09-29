"use client";

/**
 * Members — one filterable roster plus the outstanding invitations (#1527).
 *
 * Learners and Experts used to be tabs of their own; they were only role
 * filters on the same endpoint, so they are role chips on the Members list
 * now and page.tsx redirects the old `?tab=` values onto them. The page floors
 * at `members.directory` (every member, #1527 decision 3): without
 * `members.read` the Members tab is the names-only directory instead of the
 * operators' table. Invitations keeps its `invitations.manage` gate.
 */

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs, type UrlTab } from "@/components/dashboard/UrlTabs";
import { hasOrgPermission } from "@/lib/auth/org-permissions";

import { useOrgRole } from "../useOrgRole";
import { MembersPageClient } from "./MembersPageClient";
import { MemberDirectoryPanel } from "./MemberDirectoryPanel";
import { MemberInvitationsPanel } from "./MemberInvitationsPanel";

export function MembersTabs({ orgId }: { orgId: string }) {
  const { role, isLoading } = useOrgRole(orgId);

  // Hold the tabs back until the role resolves. useOrgRole defaults to
  // LEARNER while loading, which would flash a single-tab bar and then
  // expand — worse than a beat of nothing.
  if (isLoading) return null;

  const can = hasOrgPermission.bind(null, role);

  const tabs: UrlTab[] = [
    {
      value: "members",
      label: "Members",
      content: can("members.read") ? (
        <MembersPageClient orgId={orgId} />
      ) : (
        <MemberDirectoryPanel orgId={orgId} />
      ),
      show: can("members.directory"),
    },
    {
      value: "invitations",
      label: "Invitations",
      content: <MemberInvitationsPanel orgId={orgId} />,
      show: can("invitations.manage"),
    },
  ];

  return (
    <>
      <DashboardHeader
        title="Members"
        description="Everyone in this organization, and the invitations still outstanding."
      />
      <DashboardContent>
        <UrlTabs tabs={tabs} />
      </DashboardContent>
    </>
  );
}
