import type { BookingMode } from "@prisma/client";

/** How the expert page reads `ConsultantProfile.bookingMode`; pure so the button and its hint can be pinned. */
export type ConsultationCta = {
  action: "checkout" | "request";
  label: string;
  /** One line under the button, when the mode needs explaining. */
  hint: string | null;
};

/** REQUEST sends every time through approval; INSTANT pays now, and a held time is taken, never a request. */
export function consultationCtaFor(mode: BookingMode): ConsultationCta {
  if (mode === "REQUEST") {
    return {
      action: "request",
      label: "Request this time",
      hint: "Request this time — the expert confirms before you pay.",
    };
  }
  return { action: "checkout", label: "Continue to Checkout", hint: null };
}

/** The request door's refusal for an expert who takes instant bookings. */
export const REQUEST_NOT_OFFERED_MESSAGE =
  "This expert takes instant bookings. Pick a free time and continue to checkout.";

/** The consultee's recourse while the expert is paused; a pause stops new 1:1 bookings and trials. */
export const CONSULTANT_PAUSED_HINT =
  "This expert is not taking new 1:1 bookings right now — pick another expert or try again later. Their webinars and classes stay open.";

/** The metadata badge next to the price. */
export function bookingModeBadge(
  mode: BookingMode,
  acceptingRequests: boolean,
): string {
  if (!acceptingRequests) return "Not taking new 1:1 bookings";
  return mode === "REQUEST" ? "Requests reviewed first" : "Instant booking";
}
