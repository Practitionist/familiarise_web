"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";

import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import {
  orgSettingsGroups,
  orgSettingsHref,
} from "@/lib/dashboard/org-settings-sections";

import { useOrgRole } from "../useOrgRole";

/** Settings uses a grouped hub and a dedicated URL for each permitted form. */
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
      // The explicit list URL also supports existing section-list bookmarks.
      listHref={`${orgSettingsHref(orgId)}?view=sections`}
    >
      {children}
    </SettingsLayout>
  );
}
