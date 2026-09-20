"use client";

import { use } from "react";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { ConsultantSettingsLoader } from "../settings/ConsultantSettingsLoader";
import { AvailabilityForm } from "./AvailabilityForm";

/**
 * /dashboard/consultant/[consultantId]/availability — the hours a consultant
 * publishes (#1785 L-1). A top-level destination rather than a Settings tab:
 * it is a daily work surface, not a preference, which is where Calendly and
 * Cal.com put it too. `settings?tab=availability` redirects here.
 */
export default function AvailabilityPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = use(params);
  return (
    <>
      <DashboardHeader
        title="Availability"
        subtitle="The hours people can book you for, in your timezone"
      />
      <DashboardContent>
        <ConsultantSettingsLoader consultantId={consultantId}>
          {(consultant) => <AvailabilityForm consultant={consultant} />}
        </ConsultantSettingsLoader>
      </DashboardContent>
    </>
  );
}
