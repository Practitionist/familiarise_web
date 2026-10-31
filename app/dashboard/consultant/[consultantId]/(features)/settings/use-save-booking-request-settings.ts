"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TConsultantProfile } from "types/consultant";

import { useToast } from "@/hooks/use-toast";
import { userMessageFrom } from "@/lib/errors/client-refusal";
import { ApiResponseError } from "@/lib/fetch-helpers";

import {
  consultantSettingsQueryKey,
  saveBookingRequestSettings,
  type BookingRequestSettingsChange,
} from "./settings";

/**
 * Saves the Booking requests settings — shared by the Requests page's switch
 * and the Booking requests settings page. Success patches the shared settings
 * query so both surfaces agree; a change made elsewhere refetches it so the
 * screen shows the latest values, and every refusal is toasted plainly.
 */
export function useSaveBookingRequestSettings(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (change: BookingRequestSettingsChange) =>
      saveBookingRequestSettings(consultantId, change),
    onSuccess: (saved) => {
      queryClient.setQueryData<TConsultantProfile>(
        consultantSettingsQueryKey(consultantId),
        (prev) => (prev ? { ...prev, ...saved } : prev),
      );
    },
    onError: (error) => {
      if (
        error instanceof ApiResponseError &&
        error.code === "SETTINGS_CHANGED"
      ) {
        void queryClient.invalidateQueries({
          queryKey: consultantSettingsQueryKey(consultantId),
        });
      }
      toast({
        title: "Couldn't save your booking settings",
        description: userMessageFrom(error),
        variant: "destructive",
      });
    },
  });
}
