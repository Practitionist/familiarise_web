"use client";

import { use } from "react";
import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { ConsultantSettingsLoader } from "../ConsultantSettingsLoader";
import { ProfileForm } from "./ProfileForm";

/** /settings/profile — the Profile section of the hub (#1785 L-2). */
export default function ProfileSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = use(params);
  return (
    <DashboardContent>
      <ConsultantSettingsLoader consultantId={consultantId}>
        {(consultant) => <ProfileForm consultant={consultant} />}
      </ConsultantSettingsLoader>
    </DashboardContent>
  );
}
