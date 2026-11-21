"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { useServerUserId } from "@/components/dashboard/ServerUserId";
import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import { useSession } from "@/lib/auth-client";
import { fetchUserDetails } from "@/lib/user";
import { settingsSectionGroups, settingsSectionHref } from "./settings";

/** Settings uses a grouped hub and a dedicated URL for each permitted form. */
export default function ConsultantSettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { consultantId } = useParams<{ consultantId: string }>();
  const basePath = `/dashboard/consultant/${consultantId}`;
  const { data: session } = useSession();
  const serverUserId = useServerUserId();
  const userId = session?.user?.id ?? serverUserId;
  // The dashboard layout already reads this key; an unread one counts as the owner.
  const { data: userDetails } = useQuery({
    queryKey: ["user-details", userId],
    queryFn: () => fetchUserDetails(userId!),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });
  const ownsProfile = userDetails
    ? userDetails.consultantProfileId === consultantId
    : true;
  const groups = settingsSectionGroups(ownsProfile).map((group) => ({
    title: group.title,
    sections: group.sections.map((section) => ({
      key: section.key,
      label: section.label,
      description: section.description || undefined,
      show: section.show,
      href: settingsSectionHref(basePath, section),
    })),
  }));

  return (
    <SettingsLayout
      title="Settings"
      description={
        ownsProfile
          ? "Your account, public profile and business settings"
          : undefined
      }
      groups={groups}
      basePath={`${basePath}/settings`}
    >
      {children}
    </SettingsLayout>
  );
}
