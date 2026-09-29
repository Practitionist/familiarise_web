"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TConsultantProfile } from "types/consultant";

import { useToast } from "@/hooks/use-toast";
import { userMessageFrom } from "@/lib/errors/client-refusal";

import {
  consultantSettingsQueryKey,
  saveBookingRequestSettings,
  type BookingRequestSettings,
} from "./settings";

/**
 * Saves the Booking requests settings alone (#1527) — shared by the Requests
 * page's switch and the Booking requests settings page. A refusal is always
 * toasted with the server's sentence; success patches the shared settings
 * query so both surfaces agree without a refetch.
 */
export function useSaveBookingRequestSettings(consultantId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (patch: Partial<BookingRequestSettings>) =>
      saveBookingRequestSettings(consultantId, patch),
    onSuccess: (saved) => {
      queryClient.setQueryData<TConsultantProfile>(
        consultantSettingsQueryKey(consultantId),
        (prev) => (prev ? { ...prev, ...saved } : prev),
      );
    },
    onError: (error) => {
      toast({
        title: "Couldn't save your booking settings",
        description: userMessageFrom(error),
        variant: "destructive",
      });
    },
  });
}
