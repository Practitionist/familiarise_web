"use client";

import { ConsultantSettingsSectionPage } from "../ConsultantSettingsLoader";
import { BookingRequestsForm } from "./BookingRequestsForm";

/** /settings/booking — the Booking requests section of the hub (#1785 L-2). */
export default function BookingSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  return (
    <ConsultantSettingsSectionPage params={params}>
      {(consultant) => <BookingRequestsForm consultant={consultant} />}
    </ConsultantSettingsSectionPage>
  );
}
