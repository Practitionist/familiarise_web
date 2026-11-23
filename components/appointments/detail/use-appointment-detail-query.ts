"use client";

import { useQuery } from "@tanstack/react-query";

import type { TScopedAppointmentDetail } from "@/lib/data/appointment-detail";
import { toPresentationInput } from "@/lib/appointments/presentation-input";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";
import { throwSupportError } from "@/lib/support/error-copy";

/** How often a booking waiting on its payment re-reads, while the tab is visible. */
export const AWAITING_PAYMENT_POLL_MS = 15_000;

/** Whether the booking as read is waiting on its payment, the state that puts a pay prompt on screen. */
export function awaitsPayment(
  detail: TScopedAppointmentDetail | undefined,
  role: "consultee" | "consultant",
  viewerId: string | null,
): boolean {
  if (!detail) return false;
  const { bookingState } = deriveBookingPresentation(
    toPresentationInput(detail, {
      viewerId,
      names: { payer: "", consultant: "" },
      sponsorOrgName: null,
    }),
    role === "consultant" ? "CONSULTANT" : "CONSULTEE",
    // The stage reads no zone; only printed times do.
    { viewerZone: "UTC" },
  );
  return bookingState.state === "AWAITING_PAYMENT";
}

/**
 * The booking detail read. While it awaits payment it polls and refetches on
 * every return, fresh or not, so a capture made elsewhere replaces the pay prompt.
 */
export function useAppointmentDetailQuery(
  appointmentId: string,
  role: "consultee" | "consultant",
  viewerId: string | null,
) {
  return useQuery({
    queryKey: ["appointment-detail", appointmentId] as const,
    queryFn: async (): Promise<TScopedAppointmentDetail> => {
      const res = await fetch(`/api/appointments/${appointmentId}`);
      if (!res.ok) await throwSupportError(res, "appointment detail load");
      const { data } = await res.json();
      return data;
    },
    refetchOnWindowFocus: (query) =>
      awaitsPayment(query.state.data, role, viewerId) ? "always" : true,
    refetchInterval: (query) =>
      awaitsPayment(query.state.data, role, viewerId)
        ? AWAITING_PAYMENT_POLL_MS
        : false,
  });
}
