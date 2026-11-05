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

/**
 * The Booking requests section's form. It sends only the fields the user
 * changed, each with the value it replaces, so a save can never undo a change
 * made in another tab (the server answers SETTINGS_CHANGED instead).
 */
export function BookingRequestsForm({
  consultant,
}: Readonly<{ consultant: TConsultantProfile }>) {
  const save = useSaveBookingRequestSettings(consultant.id);
  const { toast } = useToast();
  const { bookingMode, acceptingRequests, maxOpenRequests } =
    getInitialBookingRequestSettings(consultant);
  const [settings, setSettings] = useState({
    bookingMode,
    acceptingRequests,
    maxOpenRequests,
  });
  // New server values (a save, or a change made elsewhere) replace the form.
  useEffect(() => {
    setSettings({ bookingMode, acceptingRequests, maxOpenRequests });
  }, [bookingMode, acceptingRequests, maxOpenRequests]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const change = bookingRequestSettingsChange(
      { bookingMode, acceptingRequests, maxOpenRequests },
      settings,
    );
    if (!change) {
      toast({ title: "Nothing to save" });
      return;
    }
    save.mutate(change, {
      onSuccess: () => toast({ title: "Booking settings saved" }),
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-6"
      aria-label="Booking requests form"
    >
      <Card>
        <CardContent className="p-6 space-y-8">
          <BookingRequestsSection value={settings} onChange={setSettings} />
        </CardContent>
      </Card>
      <SettingsFormActions
        isSaving={save.isPending}
        onReset={() =>
          setSettings({ bookingMode, acceptingRequests, maxOpenRequests })
        }
      />
    </form>
  );
}
