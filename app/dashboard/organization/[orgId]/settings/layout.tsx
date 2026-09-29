"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";

import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import {
  orgSettingsGroups,
  orgSettingsHref,
} from "@/lib/dashboard/org-settings-sections";

import { useOrgRole } from "../useOrgRole";

/**
 * Org Settings (#1527) on the shared SettingsLayout: a grouped left nav from
 * `md` up, one URL per section. Only the sections the role may open are
 * listed; each section page re-checks its gate on the server.
 */
export default function OrgSettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { orgId } = useParams<{ orgId: string }>();
  const { role, isLoading } = useOrgRole(orgId);
  // useOrgRole reads LEARNER while loading; don't flash a one-section nav.
  if (isLoading) return null;

  return (
    <SettingsLayout
      title="Organization settings"
      description="Profile, sign-in, billing contacts and integrations."
      groups={orgSettingsGroups(orgId, role)}
      basePath={orgSettingsHref(orgId)}
      // The mobile section list, as in the consultant hub.
      listHref={`${orgSettingsHref(orgId)}?view=sections`}
    >
      {children}
    </SettingsLayout>
  );
}
