"use client";

import { Card, CardContent } from "@/components/ui/card";
import { ConsultantSettingsSectionPage } from "../ConsultantSettingsLoader";
import { VerificationSection } from "../sections/VerificationSection";

/** /settings/verification — the hub section the REJECTED gate links to (#1785 L-2). */
export default function VerificationSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  return (
    <ConsultantSettingsSectionPage params={params}>
      {(consultant) => (
        <Card>
          <CardContent className="p-6">
            <VerificationSection consultant={consultant} />
          </CardContent>
        </Card>
      )}
    </ConsultantSettingsSectionPage>
  );
}
