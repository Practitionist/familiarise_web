"use client";

import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { SettingsLayout } from "@/components/dashboard/SettingsLayout";
import { useUser } from "../../UserContext";
import { consulteeSettingsGroups } from "./settings";

/** Settings uses a grouped hub and a dedicated URL for each permitted form. */
export default function ConsulteeSettingsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { consulteeId } = useParams<{ consulteeId: string }>();
  const { userDetails } = useUser();
  const ownsProfile = userDetails?.consulteeProfileId === consulteeId;
  const basePath = `/dashboard/consultee/${consulteeId}/settings`;
  return (
    <SettingsLayout
      title="Settings"
      description={
        ownsProfile
          ? "Your account, notifications and learning profile"
          : undefined
      }
      groups={consulteeSettingsGroups(consulteeId, ownsProfile)}
      basePath={basePath}
    >
      {children}
    </SettingsLayout>
  );
}
