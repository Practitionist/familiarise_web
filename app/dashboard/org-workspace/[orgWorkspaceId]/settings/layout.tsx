"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";

import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import { workspaceSettingsGroups } from "@/lib/dashboard/nav/workspace";

/** Settings uses a grouped hub and a dedicated URL for each permitted form. */
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
