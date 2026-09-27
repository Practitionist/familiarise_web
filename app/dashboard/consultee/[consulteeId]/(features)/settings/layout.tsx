"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import {
  CONSULTEE_SETTINGS_LIST_VIEW,
  consulteeSettingsGroups,
} from "./settings";

/**
 * The consultee Settings hub on the shared SettingsLayout (#1527 §14): Account,
 * Notifications and Learning profile, each its own URL. Bare `/settings` 308s
 * to Account, so the mobile back link targets the list view instead.
 */
export default function ConsulteeSettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { consulteeId } = useParams<{ consulteeId: string }>();
  const basePath = `/dashboard/consultee/${consulteeId}/settings`;
  return (
    <SettingsLayout
      title="Settings"
      description="Your account, notifications and learning profile"
      groups={consulteeSettingsGroups(consulteeId)}
      basePath={basePath}
      listHref={`${basePath}?view=${CONSULTEE_SETTINGS_LIST_VIEW}`}
    >
      {children}
    </SettingsLayout>
  );
}
