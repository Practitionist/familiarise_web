"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";

import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import { workspaceSettingsGroups } from "@/lib/dashboard/nav/workspace";

/** Workspace settings (#1527) on the shared SettingsLayout, one URL per section. */
export default function WorkspaceSettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { orgWorkspaceId } = useParams<{ orgWorkspaceId: string }>();
  const basePath = `/dashboard/org-workspace/${orgWorkspaceId}/settings`;
  return (
    <SettingsLayout
      title="Workspace settings"
      description="Preferences across all your organizations. Each organization's own settings live in its avatar menu entry."
      groups={workspaceSettingsGroups(orgWorkspaceId)}
      basePath={basePath}
      listHref={`${basePath}?view=sections`}
    >
      {children}
    </SettingsLayout>
  );
}
