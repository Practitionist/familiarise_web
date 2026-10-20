"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import {
  SETTINGS_LIST_VIEW,
  settingsSectionGroups,
  settingsSectionHref,
} from "./settings";

/** Settings uses a grouped hub and a dedicated URL for each permitted form. */
export default function ConsultantSettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { consultantId } = useParams<{ consultantId: string }>();
  const basePath = `/dashboard/consultant/${consultantId}`;
  const groups = settingsSectionGroups().map((group) => ({
    title: group.title,
    sections: group.sections.map((section) => ({
      key: section.key,
      label: section.label,
      description: section.description,
      href: settingsSectionHref(basePath, section),
    })),
  }));

  return (
    <SettingsLayout
      title="Settings"
      description="Your account, public profile and business settings"
      groups={groups}
      basePath={`${basePath}/settings`}
      listHref={`${basePath}/settings?view=${SETTINGS_LIST_VIEW}`}
    >
      {children}
    </SettingsLayout>
  );
}
