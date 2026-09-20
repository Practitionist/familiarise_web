"use client";

import { use } from "react";
import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { ConsultantSettingsLoader } from "../ConsultantSettingsLoader";
import { BookingRequestsForm } from "./BookingRequestsForm";

/** /settings/booking — the Booking requests section of the hub (#1785 L-2). */
export default function BookingSettingsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = use(params);
  return (
    <DashboardContent>
      <ConsultantSettingsLoader consultantId={consultantId}>
        {(consultant) => <BookingRequestsForm consultant={consultant} />}
      </ConsultantSettingsLoader>
    </DashboardContent>
  );
}
