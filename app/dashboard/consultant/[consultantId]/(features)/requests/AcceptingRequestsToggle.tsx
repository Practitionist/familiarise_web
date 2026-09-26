"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TConsultantProfile } from "types/consultant";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { fetchConsultantData } from "../../utils/fetchHelpers";
import { consultantSettingsQueryKey } from "../settings/settings";
import { useConsultantSettingsForm } from "../settings/use-consultant-settings-form";

/**
 * #1527 §14 — "Accepting requests" lives on the working page. It saves through
 * the Booking requests section's own form and PUT (the route takes the whole
 * profile), so the two can never disagree about the flag.
 */
export function AcceptingRequestsToggle({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const { data: consultant } = useQuery({
    queryKey: consultantSettingsQueryKey(consultantId),
    queryFn: () => fetchConsultantData(consultantId),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const settingsHref = `/dashboard/consultant/${consultantId}/settings/booking`;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {consultant && <ToggleSwitch consultant={consultant} />}
      <Link
        href={settingsHref}
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Booking settings
      </Link>
    </div>
  );
}

function ToggleSwitch({
  consultant,
}: Readonly<{ consultant: TConsultantProfile }>) {
  const id = useId();
  const router = useRouter();
  const form = useConsultantSettingsForm(consultant);
  // What the switch shows while its save is in flight; server truth otherwise.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [queued, setQueued] = useState(false);

  // The flip lands in form state first; the save runs on the next render so
  // the PUT carries it (handleSubmit reads the state it closed over). The
  // save awaits the settings query's refetch, so the prop is fresh after it.
  useEffect(() => {
    if (!queued || form.formData.acceptingRequests !== optimistic) return;
    setQueued(false);
    void form
      .handleSubmit({ preventDefault: () => undefined } as FormEvent)
      .finally(() => {
        setOptimistic(null);
        router.refresh();
      });
  }, [queued, optimistic, form, router]);

  const checked = optimistic ?? consultant.acceptingRequests ?? true;
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        checked={checked}
        disabled={form.isSaving || form.timezoneLoading || optimistic !== null}
        onCheckedChange={(next) => {
          form.setFormData((prev) => ({ ...prev, acceptingRequests: next }));
          setOptimistic(next);
          setQueued(true);
        }}
      />
      <Label htmlFor={id} className="text-sm font-medium">
        Accepting requests
      </Label>
    </div>
  );
}
