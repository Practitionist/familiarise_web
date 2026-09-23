"use client";

import type { TConsultantProfile } from "types/consultant";
import { Card, CardContent } from "@/components/ui/card";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { BookingRequestsSection } from "../sections/BookingRequestsSection";
import { SettingsFormActions } from "../SettingsFormActions";
import { useConsultantSettingsForm } from "../use-consultant-settings-form";

/** The Booking requests section's form (#1703 D1/D4 fields on the combined PUT). */
export function BookingRequestsForm({
  consultant,
}: Readonly<{ consultant: TConsultantProfile }>) {
  const form = useConsultantSettingsForm(consultant);

  if (form.timezoneLoading) return <SettingsSkeleton />;

  return (
    <form
      onSubmit={form.handleSubmit}
      className="space-y-6"
      aria-label="Booking requests form"
    >
      <Card>
        <CardContent className="p-6 space-y-8">
          <BookingRequestsSection
            formData={form.formData}
            setFormData={form.setFormData}
          />
        </CardContent>
      </Card>
      <SettingsFormActions isSaving={form.isSaving} onReset={form.reset} />
    </form>
  );
}
