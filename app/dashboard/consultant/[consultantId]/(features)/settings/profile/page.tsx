"use client";

import { ConsultantSettingsSectionPage } from "../ConsultantSettingsLoader";
import { ProfileForm } from "./ProfileForm";

/** /settings/profile — the Profile section of the hub (#1785 L-2). */
export default function ProfileSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  return (
    <ConsultantSettingsSectionPage params={params}>
      {(consultant) => <ProfileForm consultant={consultant} />}
    </ConsultantSettingsSectionPage>
  );
}
