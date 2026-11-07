"use client";

import { ConsultantSettingsSectionPage } from "../ConsultantSettingsLoader";
import { BookingRequestsForm } from "./BookingRequestsForm";

/** /settings/booking — the Booking mode section of the hub. */
export default function BookingSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  return (
    <ConsultantSettingsSectionPage params={params}>
      {(consultant) => <BookingRequestsForm consultant={consultant} />}
    </ConsultantSettingsSectionPage>
  );
}
