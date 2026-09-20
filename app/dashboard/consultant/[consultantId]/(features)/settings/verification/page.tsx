"use client";

import { use } from "react";
import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { Card, CardContent } from "@/components/ui/card";
import { ConsultantSettingsLoader } from "../ConsultantSettingsLoader";
import { VerificationSection } from "../sections/VerificationSection";

/** /settings/verification — the hub section the REJECTED gate links to (#1785 L-2). */
export default function VerificationSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = use(params);
  return (
    <DashboardContent>
      <ConsultantSettingsLoader consultantId={consultantId}>
        {(consultant) => (
          <Card>
            <CardContent className="p-6">
              <VerificationSection consultant={consultant} />
            </CardContent>
          </Card>
        )}
      </ConsultantSettingsLoader>
    </DashboardContent>
  );
}
