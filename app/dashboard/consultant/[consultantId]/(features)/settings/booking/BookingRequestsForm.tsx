"use client";

import type { FormEvent } from "react";
import type { TConsultantProfile } from "types/consultant";
import { Card, CardContent } from "@/components/ui/card";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { useToast } from "@/hooks/use-toast";
import { BookingRequestsSection } from "../sections/BookingRequestsSection";
import { SettingsFormActions } from "../SettingsFormActions";
import { useConsultantSettingsForm } from "../use-consultant-settings-form";
import { useSaveBookingRequestSettings } from "../use-save-booking-request-settings";

/**
 * The Booking requests section's form (#1703 D1/D4). It saves only its three
 * fields through the narrow PATCH (#1527), so a stale availability overlap
 * cannot refuse a booking-settings change.
 */
export function BookingRequestsForm({
  consultant,
}: Readonly<{ consultant: TConsultantProfile }>) {
  const form = useConsultantSettingsForm(consultant);
  const save = useSaveBookingRequestSettings(consultant.id);
  const { toast } = useToast();

  if (form.timezoneLoading) return <SettingsSkeleton />;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const { bookingMode, acceptingRequests, maxOpenRequests } = form.formData;
    save.mutate(
      { bookingMode, acceptingRequests, maxOpenRequests },
      { onSuccess: () => toast({ title: "Booking settings saved" }) },
    );
  };

  return (
    <form
      onSubmit={onSubmit}
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
      <SettingsFormActions isSaving={save.isPending} onReset={form.reset} />
    </form>
  );
}
