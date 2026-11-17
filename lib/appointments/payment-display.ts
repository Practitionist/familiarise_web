/**
 * How one Payment row reads on the attendee's booking page: who funded it,
 * which rail it rode, and where its receipt is. Pure, so the detail client
 * can import it (prisma → pg → fs breaks the build) and a test can pin it.
 *
 * The funding legs are the runtime truth for sponsorship and for the rail's
 * wording; `paymentMethod` is read only for a row with no legs. `Appointment.organizationId`
 * is NOT a sponsorship signal — checkout stamps it on a PERSONAL-funded booking
 * too, where the member paid their own card and must see the amount.
 */

import { formatCurrencyAmount } from "@/utils/formatting";

export type PaymentFunding = "ORG" | "SELF" | "CREDITS";

export type PaymentDisplayLike = {
  id: string;
  paymentStatus: string;
  paymentMethod: string;
  paymentGateway: string;
  receiptUrl: string | null;
  consumerInvoice: { id: string } | null;
  legs?: ReadonlyArray<{ source: string; amountPaise?: PaiseLike }>;
  refunds?: ReadonlyArray<{ amountPaise: PaiseLike }>;
};

type PaiseLike = bigint | number | string;

/** The funding leg sources in display order; `*_REVERSAL` legs are refunds, not funding. */
const FUNDING_LEG_ORDER = [
  "CARD",
  "REFERRAL_CREDIT",
  "WALLET",
  "INVOICE_ACCRUAL",
  "OVERAGE_INVOICE_ACCRUAL",
  "LICENSE",
] as const;

export type FundingLegSource = (typeof FUNDING_LEG_ORDER)[number];

/** Each funding leg's rail in the payer's words. */
const LEG_RAIL_LABEL: Record<FundingLegSource, string> = {
  CARD: "card / UPI",
  REFERRAL_CREDIT: "referral credit",
  WALLET: "organisation wallet",
  INVOICE_ACCRUAL: "invoiced to the organisation",
  OVERAGE_INVOICE_ACCRUAL: "invoiced to the organisation",
  LICENSE: "organisation licence",
};

const ORG_LEG_SOURCES = new Set<string>([
  "WALLET",
  "LICENSE",
  "INVOICE_ACCRUAL",
  "OVERAGE_INVOICE_ACCRUAL",
]);

/** The values checkout writes; anything else (seed strings) is the payer's own. */
const ORG_METHODS = new Set(["WALLET", "INVOICE", "LICENSE"]);

/** The two fields the funding rule reads; an earner-side row need carry no more. */
export type PaymentFundingLike = Pick<
  PaymentDisplayLike,
  "legs" | "paymentMethod"
>;

export function paymentFunding(p: PaymentFundingLike): PaymentFunding {
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

export const isSponsoredPayment = (p: PaymentFundingLike): boolean =>
  paymentFunding(p) === "ORG";

/** The money states in which the viewer's money was actually taken. */
const MONEY_TAKEN_STATES: ReadonlySet<string> = new Set([
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUND_PENDING",
  "REFUNDED",
  "DISPUTED",
]);

/**
 * Whether the viewer was charged: the booking's money state says money was
 * taken, or the viewer paid a co-pay of their own (an organisation-paid
 * overage child is not theirs).
 */
export function viewerWasCharged(
  moneyState: string,
  payments: readonly {
    childPayments: readonly (PaymentFundingLike & {
      userId: string | null;
      paymentStatus: string;
      amount: number | string;
    })[];
  }[],
  viewerId: string | null | undefined,
): boolean {
  if (MONEY_TAKEN_STATES.has(moneyState)) return true;
  return payments.some((p) =>
    p.childPayments.some(
      (c) =>
        c.userId === viewerId &&
        c.paymentStatus === "SUCCEEDED" &&
        Number(c.amount) > 0 &&
        !isSponsoredPayment(c),
    ),
  );
}

/** Who paid, in plain words: the sponsoring organisation, or the attendee. */
export function payerSentence(
  funding: PaymentFunding,
  organizationName: string | null,
): string {
  if (funding !== "ORG") return "Paid by you";
  return organizationName
    ? `Paid by ${organizationName}`
    : "Paid by your organisation";
}

const GATEWAY_NAME: Record<string, string> = {
  RAZORPAY: "Razorpay",
  STRIPE: "Stripe",
};

/**
 * "via …" on the money line. A self-paid row names the gateway, since CARD is
 * recorded for every gateway charge; an org or credit row names its lead leg.
 */
export function paymentRailLabel(p: PaymentDisplayLike): string | null {
  const funding = paymentFunding(p);
  if (funding === "SELF") return GATEWAY_NAME[p.paymentGateway] ?? null;
  const sources = new Set((p.legs ?? []).map((l) => l.source));
  if (sources.size > 0) {
    const lead = FUNDING_LEG_ORDER.find(
      (s) =>
        sources.has(s) && (funding === "CREDITS" || ORG_LEG_SOURCES.has(s)),
    );
    if (lead) return LEG_RAIL_LABEL[lead];
  }
  if (funding === "CREDITS") return "credits";
  if (p.paymentMethod === "INVOICE") return LEG_RAIL_LABEL.INVOICE_ACCRUAL;
  if (p.paymentMethod === "LICENSE") return LEG_RAIL_LABEL.LICENSE;
  return LEG_RAIL_LABEL.WALLET;
}

export interface FundingBreakdownEntry {
  source: FundingLegSource;
  label: string;
  amountPaise: number;
}

/**
 * What each rail carried, merged by wording and in a fixed order. Reversal
 * legs are left to the refund lines. Every entry but REFERRAL_CREDIT and a
 * 0-value LICENSE sums to `Payment.amount` (the payment_legs_sum_to_amount trigger).
 */
export function paymentFundingBreakdown(
  legs: ReadonlyArray<{ source: string; amountPaise: PaiseLike }>,
): FundingBreakdownEntry[] {
  const byLabel = new Map<string, FundingBreakdownEntry>();
  for (const source of FUNDING_LEG_ORDER) {
    const label = LEG_RAIL_LABEL[source];
    for (const leg of legs.filter((l) => l.source === source)) {
      const entry = byLabel.get(label) ?? { source, label, amountPaise: 0 };
      entry.amountPaise += Number(leg.amountPaise);
      byLabel.set(label, entry);
    }
  }
  const entries = [...byLabel.values()];
  const funded = entries.filter((e) => e.amountPaise !== 0);
  return funded.length > 0 ? funded : entries;
}

export interface PaymentDiscountBreakdown {
  /** Paise a discount code took off the list price; 0 when no code was used. */
  codeDiscountPaise: number;
  /** Paise the referral welcome discount took off the list price. */
  welcomeDiscountPaise: number;
}

/**
 * The pre-tax discounts on one Payment, from the stored fields alone.
 * `amount` = `originalAmount` - discounts + `taxAmount` - referral credit, so
 * the code's share is what remains once the welcome discount and the credit
 * legs are accounted for. A row with no code never reports a code discount.
 */
export function paymentDiscountBreakdown(p: {
  originalAmount: PaiseLike;
  taxAmount: PaiseLike;
  amount: PaiseLike;
  welcomeDiscountPaise?: PaiseLike | null;
  hasDiscountCode: boolean;
  legs?: ReadonlyArray<{ source: string; amountPaise: PaiseLike }>;
}): PaymentDiscountBreakdown {
  const welcome = Math.max(0, Number(p.welcomeDiscountPaise ?? 0));
  if (!p.hasDiscountCode) {
    return { codeDiscountPaise: 0, welcomeDiscountPaise: welcome };
  }
  const credits = (p.legs ?? [])
    .filter((l) => l.source === "REFERRAL_CREDIT")
    .reduce((sum, l) => sum + Number(l.amountPaise), 0);
  const totalDiscount =
    Number(p.originalAmount) + Number(p.taxAmount) - credits - Number(p.amount);
  return {
    codeDiscountPaise: Math.max(0, totalDiscount - welcome),
    welcomeDiscountPaise: welcome,
  };
}

/** "₹800 card / UPI + ₹200 referral credit". */
export function formatFundingBreakdown(
  entries: ReadonlyArray<FundingBreakdownEntry>,
  currency: string,
): string {
  return entries
    .map((e) => `${formatCurrencyAmount(e.amountPaise, currency)} ${e.label}`)
    .join(" + ");
}

/**
 * The buyer's receipt: the statutory tax invoice when one was issued (#1365),
 * else the gateway receipt the row carries (#1527 CE-32: fetched, never
 * rendered). Only a captured payment has one to show — a refund does not
 * unissue the invoice, it adds a credit note beside it.
 */
export function receiptHref(p: PaymentDisplayLike): string | null {
  if (p.paymentStatus !== "SUCCEEDED") return null;
  if (p.consumerInvoice) return `/api/payments/${p.id}/invoice/pdf`;
  if (p.receiptUrl && /^https?:\/\//.test(p.receiptUrl)) return p.receiptUrl;
  return null;
}

export type RefundRail = "GATEWAY" | "INTERNAL" | "CREDITS" | null;

export interface RefundRailAmounts {
  estimatedRefundPaise: number;
  currency: string;
  refundPct: number;
  prorated: boolean;
  /** Nothing was paid, in money or in referral credit: a free booking. */
  freeBooking?: boolean;
}

/** The sentence for a booking that cost nothing; shared by the dialog, the toast and the preview. */
export const FREE_BOOKING_REFUND_LINE =
  "Nothing was paid for this, so there is nothing to refund.";

/**
 * A SUCCEEDED payment worth nothing: no gateway amount and no referral credit
 * leg. A credit-funded booking also has amount 0 but carries a credit leg.
 */
export function isFreePayment(p: {
  amount: PaiseLike;
  paymentMethod: string;
  legs?: PaymentDisplayLike["legs"];
}): boolean {
  if (Number(p.amount) !== 0 || ORG_METHODS.has(p.paymentMethod)) return false;
  if (!p.legs) return false;
  return !p.legs.some(
    (l) =>
      ORG_LEG_SOURCES.has(l.source) ||
      (l.source === "REFERRAL_CREDIT" && Number(l.amountPaise ?? 0) > 0),
  );
}

/**
 * The refund sentence for one seat, by the rail the money comes back on.
 * Credits are all-or-nothing (#1161): only a full-refund window restores them
 * automatically. On the INTERNAL rail the learner never paid — the wallet,
 * invoice accrual or licence did — so the sentence never names their card.
 */
export function refundRailLine(
  fundingRail: RefundRail,
  amounts: RefundRailAmounts,
): string {
  if (amounts.freeBooking) return FREE_BOOKING_REFUND_LINE;
  if (fundingRail === "CREDITS") {
    return amounts.refundPct === 100
      ? "You paid with referral credits — they'll be restored to your balance."
      : "You paid with referral credits, and this cancellation falls in a partial-refund window — restoration is reviewed manually rather than returned automatically.";
  }
  if (amounts.estimatedRefundPaise <= 0) {
    return "No refund at this notice — cancelling now returns nothing under the booking's cancellation policy.";
  }
  const amount = `~${formatCurrencyAmount(amounts.estimatedRefundPaise, amounts.currency)}`;
  const terms = `(${amounts.refundPct}%${amounts.prorated ? ", prorated for sessions already held" : ""})`;
  return fundingRail === "INTERNAL"
    ? `Your organisation is credited ${amount} ${terms}. Your organisation's balance is restored; nothing was charged to you.`
    : `You'll be refunded ${amount} ${terms}. Refunds reach your original payment method in 5–7 working days.`;
}
