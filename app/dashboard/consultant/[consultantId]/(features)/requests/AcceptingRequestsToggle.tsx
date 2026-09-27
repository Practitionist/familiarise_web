"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TConsultantProfile } from "types/consultant";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { fetchConsultantData } from "../../utils/fetchHelpers";
import { consultantSettingsQueryKey } from "../settings/settings";
import { useSaveBookingRequestSettings } from "../settings/use-save-booking-request-settings";

/**
 * #1527 §14 — "Accepting requests" lives on the working page. It saves the
 * one flag through the narrow booking-settings PATCH (the whole-profile PUT
 * 400'd on any stale availability overlap and the switch reverted silently)
 * and shares the settings query with the Booking requests page.
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
  const save = useSaveBookingRequestSettings(consultant.id);

  // Optimistic while in flight; server truth otherwise (a failure reverts
  // and the hook toasts why).
  const checked = save.isPending
    ? (save.variables.acceptingRequests ?? true)
    : (consultant.acceptingRequests ?? true);
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        checked={checked}
        disabled={save.isPending}
        onCheckedChange={(next) =>
          save.mutate(
            { acceptingRequests: next },
            // The paused banner is server-rendered from the profile.
            { onSuccess: () => router.refresh() },
          )
        }
      />
      <Label htmlFor={id} className="text-sm font-medium">
        Accepting requests
      </Label>
    </div>
  );
}
