/**
 * The platform's GST registration regime, derived from PLATFORM_GSTIN alone:
 * a valid GSTIN from the registered office's state means REGISTERED (GST is
 * charged and invoiced); an unset one means UNREGISTERED (no GST, no tax
 * invoice, organisation-funded rails refused). A set but invalid or wrong-state
 * GSTIN is a misconfiguration, so every pricing path refuses rather than
 * silently charging 0%.
 */

import type { GstRegime } from "@prisma/client";

import { Refusal } from "@/lib/errors/refusal";
import { isPlatformGstRegistered } from "@/lib/pdf/supplier";

export type { GstRegime };

/** Typed refusal code for the organisation-funded rails while unregistered. */
export const GST_REGISTRATION_REQUIRED = "GST_REGISTRATION_REQUIRED";

/** Typed refusal code for a PLATFORM_GSTIN that is set but unusable. */
export const GST_CONFIG_INVALID = "GST_CONFIG_INVALID";

export const GST_REGISTRATION_REQUIRED_MESSAGE =
  "Organisation billing becomes available once the platform completes GST registration.";

/**
 * The regime new orders are priced under. Throws a 503 `GST_CONFIG_INVALID`
 * refusal when PLATFORM_GSTIN is set but malformed or from another state.
 */
export function currentGstRegime(): GstRegime {
  if (isPlatformGstRegistered()) return "REGISTERED";
  if (process.env.PLATFORM_GSTIN?.trim()) {
    throw new Refusal({
      code: GST_CONFIG_INVALID,
      httpStatus: 503,
      userMessage:
        "Checkout is temporarily unavailable. Please try again later — you were not charged.",
      devMessage:
        "PLATFORM_GSTIN is set but malformed or registered in a state other than the registered office; pricing refuses instead of charging 0% GST.",
    });
  }
  return "UNREGISTERED";
}

/** Organisation-funded money (wallet, invoice, licence, org invoices) needs a GST registration. */
export function assertOrgBillingAvailable(regime: GstRegime): void {
  if (regime === "REGISTERED") return;
  throw new Refusal({
    code: GST_REGISTRATION_REQUIRED,
    httpStatus: 403,
    userMessage: GST_REGISTRATION_REQUIRED_MESSAGE,
    devMessage:
      "Organisation-funded billing refused: the platform is not GST-registered (PLATFORM_GSTIN unset).",
  });
}
