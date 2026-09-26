"use client";

/**
 * Members — one roster, four views.
 *
 * Learners, Experts and Invitations used to be their own sidebar entries.
 * The first two were nothing but `?role=` filters on the very endpoint the
 * roster already reads, so the org sidebar spent four slots on one dataset.
 * They're tabs now, addressable as `?tab=learners` etc. so the retired routes
 * still resolve.
 *
 * Each tab carries the same matrix key its old route guard used, so a role
 * that couldn't reach the page can't reach the tab either. The page floors at
 * `members.directory` (every member, #1527 decision 3): without `members.read`
 * the All tab is the names-only directory instead of the operators' table.
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
import { LearnersPanel } from "./LearnersPanel";
import { ExpertsPanel } from "./ExpertsPanel";
import { MemberInvitationsPanel } from "./MemberInvitationsPanel";

export function MembersTabs({ orgId }: { orgId: string }) {
  const { role, canSponsor, canHost, isLoading } = useOrgRole(orgId);

  // Hold the tabs back until the role resolves. useOrgRole defaults to
  // LEARNER while loading, which would flash a single-tab bar and then
  // expand — worse than a beat of nothing.
  if (isLoading) return null;

  const can = hasOrgPermission.bind(null, role);

  const tabs: UrlTab[] = [
    {
      value: "all",
      label: "All",
      content: can("members.read") ? (
        <MembersPageClient orgId={orgId} />
      ) : (
        <MemberDirectoryPanel orgId={orgId} />
      ),
      show: can("members.directory"),
    },
    {
      value: "learners",
      label: "Learners",
      content: <LearnersPanel orgId={orgId} />,
      show: canSponsor && can("learners.read"),
    },
    {
      value: "experts",
      label: "Experts",
      content: <ExpertsPanel orgId={orgId} />,
      show: canHost && can("experts.read"),
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
