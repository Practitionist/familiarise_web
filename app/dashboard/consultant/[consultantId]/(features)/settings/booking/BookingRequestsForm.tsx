"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { TConsultantProfile } from "types/consultant";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { BookingRequestsSection } from "../sections/BookingRequestsSection";
import { SettingsFormActions } from "../SettingsFormActions";
import {
  bookingRequestSettingsChange,
  getInitialBookingRequestSettings,
} from "../settings";
import { useSaveBookingRequestSettings } from "../use-save-booking-request-settings";
import { usePlanClients } from "../use-plan-clients";

/**
 * The Booking mode section's form. It sends only the fields the user
 * changed, each with the value it replaces, so a save can never undo a change
 * made in another tab (the server answers SETTINGS_CHANGED instead).
 */
export function BookingRequestsForm({
  consultant,
}: Readonly<{ consultant: TConsultantProfile }>) {
  const save = useSaveBookingRequestSettings(consultant.id);
  const { toast } = useToast();
  const {
    bookingMode,
    acceptingRequests,
    maxOpenRequests,
    maxActivePlanClients,
  } = getInitialBookingRequestSettings(consultant);
  const shown = {
    bookingMode,
    acceptingRequests,
    maxOpenRequests,
    maxActivePlanClients,
  };
  const [settings, setSettings] = useState(shown);
  const planClients = usePlanClients(consultant.id);
  // New server values (a save, or a change made elsewhere) replace the form.
  useEffect(() => {
    setSettings({
      bookingMode,
      acceptingRequests,
      maxOpenRequests,
      maxActivePlanClients,
    });
  }, [bookingMode, acceptingRequests, maxOpenRequests, maxActivePlanClients]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const change = bookingRequestSettingsChange(shown, settings);
    if (!change) {
      toast({ title: "Nothing to save" });
      return;
    }
    save.mutate(change, {
      onSuccess: () => {
        toast({ title: "Booking settings saved" });
        void planClients.refetch();
      },
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-6"
      aria-label="Booking mode form"
    >
      <Card>
        <CardContent className="p-6 space-y-8">
          <BookingRequestsSection
            value={settings}
            onChange={setSettings}
            activePlanClients={planClients.data?.activePlanClients ?? null}
          />
        </CardContent>
      </Card>
      <SettingsFormActions
        isSaving={save.isPending}
        onReset={() => setSettings(shown)}
      />
    </form>
  );
}
