"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import {
  CONSULTEE_SETTINGS_LIST_VIEW,
  consulteeSettingsGroups,
} from "./settings";

/** Settings uses a grouped hub and a dedicated URL for each permitted form. */
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
