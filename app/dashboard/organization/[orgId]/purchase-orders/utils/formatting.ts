/**
 * Display helpers for the PurchaseOrders dashboard.
 *
 * Currency formatting differs by currency: INR uses zero-decimal output
 * (POs are large finance-team numbers; sub-rupee noise hurts scanability)
 * while forex uses two-decimal output (where sub-unit precision matters).
 */

import type { Tone } from "@/lib/ui/tone";

import type { PoCurrency, PoStatus } from "./types";

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function fmtMoney(paise: number, currency: PoCurrency): string {
  const value = paise / 100;
  if (currency === "INR") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

/** #1762-4 — labels + tones instead of the raw enum. */
export const PO_STATUS: Record<PoStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: "Active", tone: "success" },
  CLOSED: { label: "Closed", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export const PO_STATUSES: PoStatus[] = ["ACTIVE", "CLOSED", "CANCELLED"];
