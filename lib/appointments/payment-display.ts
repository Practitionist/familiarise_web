/**
 * How one Payment row reads on the attendee's booking page: who funded it,
 * which rail it rode, and where its receipt is. Pure, so the detail client
 * can import it (prisma → pg → fs breaks the build) and a test can pin it.
 *
 * The funding legs are the runtime truth for sponsorship; `paymentMethod` is
 * the fallback for rows written before legs existed. `Appointment.organizationId`
 * is NOT a sponsorship signal — checkout stamps it on a PERSONAL-funded booking
 * too, where the member paid their own card and must see the amount.
 */

export type PaymentFunding = "ORG" | "SELF" | "CREDITS";

export type PaymentDisplayLike = {
  id: string;
  paymentStatus: string;
  paymentMethod: string;
  paymentGateway: string;
  receiptUrl: string | null;
  consumerInvoice: { id: string } | null;
  legs?: ReadonlyArray<{ source: string }>;
};

const ORG_LEG_SOURCES = new Set([
  "WALLET",
  "LICENSE",
  "INVOICE_ACCRUAL",
  "OVERAGE_INVOICE_ACCRUAL",
]);

/** The values checkout writes; anything else (seed strings) is the payer's own. */
const ORG_METHODS = new Set(["WALLET", "INVOICE", "LICENSE"]);

export function paymentFunding(p: PaymentDisplayLike): PaymentFunding {
  const legs = p.legs ?? [];
  if (legs.length > 0) {
    if (legs.some((l) => ORG_LEG_SOURCES.has(l.source))) return "ORG";
    if (legs.some((l) => l.source === "CARD")) return "SELF";
    return "CREDITS";
  }
  if (ORG_METHODS.has(p.paymentMethod)) return "ORG";
  if (p.paymentMethod === "CREDITS") return "CREDITS";
  return "SELF";
}

export const isSponsoredPayment = (p: PaymentDisplayLike): boolean =>
  paymentFunding(p) === "ORG";

const GATEWAY_NAME: Record<string, string> = {
  RAZORPAY: "Razorpay",
  STRIPE: "Stripe",
};

/**
 * "via …" on the money line. The gateway is named, not the instrument: the
 * row records CARD for every gateway charge, UPI included, so "card" would be
 * a guess. Null when nothing honest can be said.
 */
export function paymentRailLabel(p: PaymentDisplayLike): string | null {
  switch (paymentFunding(p)) {
    case "ORG":
      if (p.paymentMethod === "INVOICE") return "invoiced to the organisation";
      if (p.paymentMethod === "LICENSE") return "organisation licence";
      return "organisation wallet";
    case "CREDITS":
      return "credits";
    default:
      return GATEWAY_NAME[p.paymentGateway] ?? null;
  }
}

/**
 * The buyer's receipt: the statutory tax invoice when one was issued (#1365),
 * else the gateway receipt the row carries (#1527 CE-32: fetched, never
 * rendered). Only a captured payment has one to show.
 */
export function receiptHref(p: PaymentDisplayLike): string | null {
  if (p.paymentStatus !== "SUCCEEDED") return null;
  if (p.consumerInvoice) return `/api/payments/${p.id}/invoice/pdf`;
  if (p.receiptUrl && /^https?:\/\//.test(p.receiptUrl)) return p.receiptUrl;
  return null;
}
