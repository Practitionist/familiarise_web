import type { BookingMode } from "@prisma/client";

/**
 * #1703 D1 — the consultee-facing reading of `ConsultantProfile.bookingMode`.
 * Pure so the expert page's CTA and badge can be pinned without a DOM.
 */

export type ConsultationCta = {
  action: "checkout" | "request";
  label: string;
  /** One line under the button, when the mode needs explaining. */
  hint: string | null;
};

/**
 * INSTANT keeps the pre-#1703 arm: pay now on a free slot, request only on a
 * contended one. REQUEST routes every slot through approval.
 */
export function consultationCtaFor(
  mode: BookingMode,
  slotIsAllocated: boolean,
): ConsultationCta {
  if (mode === "REQUEST") {
    return {
      action: "request",
      label: "Request this time",
      hint: "Request this time — the expert confirms before you pay.",
    };
  }
  if (slotIsAllocated) {
    // #1785 L-3 — the slot list marks a contended time with a "Request" tag;
    // the sentence under the button says what the tag means.
    return {
      action: "request",
      label: "Request for Approval",
      hint: "Someone else is asking for this time too — the expert confirms before you pay.",
    };
  }
  return { action: "checkout", label: "Continue to Checkout", hint: null };
}

/** The consultee's recourse while the expert is paused (#1703 D4). */
export const CONSULTANT_PAUSED_HINT =
  "This expert is not taking new requests right now — pick another expert or try again later.";

/** The metadata badge next to the price. */
export function bookingModeBadge(
  mode: BookingMode,
  acceptingRequests: boolean,
): string {
  if (mode === "REQUEST" && !acceptingRequests) {
    return "Not taking new requests";
  }
  return mode === "REQUEST" ? "Requests reviewed first" : "Instant booking";
}
