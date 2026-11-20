/**
 * An invoice's dates (issue, due, billing period, credit note) are the
 * supplier's India calendar dates: every PDF, screen, export and notice prints
 * them in IST, whoever reads them and wherever the code runs.
 */

import { formatOperatorInstant, type Instant } from "./operator-zone";

export const INVOICE_DATE_ZONE_LABEL = "IST";

/** "20 Oct 2026", the India date of the instant; "—" for none. */
export function formatInvoiceDate(at: Instant | null | undefined): string {
  return at === null || at === undefined
    ? "—"
    : formatOperatorInstant(at, "date");
}

/** "20 Oct 2026 (IST)", for prose where a reader would assume their own zone. */
export function formatInvoiceDateWithZone(
  at: Instant | null | undefined,
): string {
  const day = formatInvoiceDate(at);
  return day === "—" ? day : `${day} (${INVOICE_DATE_ZONE_LABEL})`;
}

/** "Due (IST)": the heading of a field or column that holds invoice dates. */
export function invoiceDateLabel(label: string): string {
  return `${label} (${INVOICE_DATE_ZONE_LABEL})`;
}
