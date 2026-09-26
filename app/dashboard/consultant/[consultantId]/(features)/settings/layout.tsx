"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import {
  SETTINGS_LIST_VIEW,
  settingsSectionGroups,
  settingsSectionHref,
} from "./settings";

/**
 * The consultant Settings hub (#1785 L-2) on the shared SettingsLayout
 * (#1527): grouped left nav from `md` up, list → detail below it. Every
 * section is its own URL. Bare `/settings` still 308s to the first section,
 * so the mobile back link targets the list view instead.
 */
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
