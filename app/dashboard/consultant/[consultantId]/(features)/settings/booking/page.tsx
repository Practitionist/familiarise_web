"use client";

import { ConsultantSettingsSectionPage } from "../ConsultantSettingsLoader";
import { BookingRequestsForm } from "./BookingRequestsForm";
import { ReliabilityCard } from "./ReliabilityCard";

/** /settings/booking — the Booking mode section of the hub. */
export default function BookingSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  return (
    <ConsultantSettingsSectionPage params={params}>
      {(consultant) => (
        <div className="space-y-6">
          <BookingRequestsForm consultant={consultant} />
          <ReliabilityCard consultantId={consultant.id} />
        </div>
      )}
    </ConsultantSettingsSectionPage>
  );
}
