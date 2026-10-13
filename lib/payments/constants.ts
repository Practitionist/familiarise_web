/**
 * Payment-related constants used across the application
 */

import { PaymentGateway } from "@prisma/client";

/** Time in hours before an approval payment link expires (#1703 D2: 48 → 24). */
export const APPROVAL_PAYMENT_EXPIRATION_HOURS = 24;

/** Time in milliseconds before an approval payment link expires */
export const APPROVAL_PAYMENT_EXPIRATION_MS =
  APPROVAL_PAYMENT_EXPIRATION_HOURS * 60 * 60 * 1000;

/** #1703 D2 — the one reminder fires when this much of the window is left. */
export const APPROVAL_PAYMENT_REMINDER_MS = APPROVAL_PAYMENT_EXPIRATION_MS / 2;

/** Minimum booking lead time in milliseconds (15 minutes) */
export const MINIMUM_BOOKING_LEAD_TIME_MS = 15 * 60 * 1000;

/** Minimum booking lead time in minutes */
export const MINIMUM_BOOKING_LEAD_TIME_MINUTES = 15;

/** `PaymentGateway` enum labels with no implementation; every money path refuses them. */
export const UNIMPLEMENTED_GATEWAYS = [
  PaymentGateway.STRIPE,
  PaymentGateway.DODO_PAYMENTS,
] as const satisfies readonly PaymentGateway[];

const UNIMPLEMENTED_GATEWAY_SET: ReadonlySet<PaymentGateway> = new Set(
  UNIMPLEMENTED_GATEWAYS,
);

export function isUnimplementedGateway(gateway: PaymentGateway): boolean {
  return UNIMPLEMENTED_GATEWAY_SET.has(gateway);
}
