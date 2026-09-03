/**
 * B2C (personal-consultee) tax invoices and credit notes — #1365.
 *
 * The platform bills as PRINCIPAL supplier for GST (ADR 26): checkout charges
 * 18% on the discounted price and settlement credits GST_PAYABLE. What was
 * missing was the DOCUMENT trail — a consumer paid tax and received nothing
 * that a GST officer, or the buyer's own accountant, would recognise as a tax
 * invoice. This module mints that document, and the s.34 credit note that
 * reverses it on a refund.
 *
 * It is document-only. Nothing here posts to the ledger, and nothing here
 * derives tax from a rate: the tax heads are split out of the tax the buyer
 * was actually charged, so the invoice agrees with the GST_PAYABLE credit to
 * the paise. A rate-derived figure would drift from it the first time rounding
 * or a discount changed the base.
 *
 * This module must never import a PDF renderer — it is called from the
 * checkout and webhook transaction paths, and pulling a rendering engine into
 * those bundles is both a cold-start cost and a needless failure surface.
 * Rendering lives in lib/pdf/, behind the download routes, and a CI grep keeps
 * the renderer package out of lib/payments entirely.
 */

import type { Tx } from "@/lib/prisma";
import { numericStateCode } from "@/lib/compliance/state-codes";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { TAX_CONSTANTS } from "@/lib/payments/payouts/constants";
import { getPlatformSupplier } from "@/lib/pdf/supplier";
import { generateConsumerInvoiceNumber } from "@/lib/payments/billing/invoice-numbering";
import { generateConsumerCreditNoteNumber } from "@/lib/payments/billing/credit-note-numbering";
import type { PlaceOfSupplySource } from "@prisma/client";

/** 18% expressed in basis points — recorded on the document, never used to
 *  re-derive the heads. */
const CONSUMER_TAX_RATE_BPS = 1800;

/** Rule 46: a B2C invoice of ₹50,000 or more must carry the recipient's name,
 *  address and state. */
const RULE_46_ADDRESS_THRESHOLD_PAISE = 5_000_000;

export interface ConsumerInvoiceTax {
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  placeOfSupply: string | null;
  placeOfSupplySource: PlaceOfSupplySource;
  /** Machine-readable classification, mirroring `deriveGstBreakdown.reason`,
   *  so an unusual document can be found in the register without re-deriving. */
  reason: string;
}

/**
 * Split the tax a consumer was already charged into the correct GST heads.
 *
 * PURE — no I/O, no clock, no environment beyond what the caller passes in.
 *
 * Place of supply for a B2C supply follows s.12(2)(b) IGST Act: where the
 * recipient's address is not on record, the place of supply is the SUPPLIER's
 * location. That is the exact opposite of the B2B fallback in
 * `deriveGstBreakdown`, which reports IGST on an unknown buyer state as a
 * deliberate audit signal — a registered buyer is expected to have a state, so
 * a missing one is a defect. For a consumer it is the statutory norm, so an
 * absent state produces an intra-state (CGST+SGST) document, not IGST.
 *
 * @param buyerStateCode alpha or numeric; normalised here.
 * @param supplierStateCode the platform's own state (env `SUPPLIER_STATE_CODE`).
 */
export function deriveConsumerInvoiceTax(params: {
  /** Tax-inclusive amount the buyer was charged, paise. */
  totalPaise: number;
  /** The tax component of that amount, paise (`Payment.taxAmount`). */
  taxAmountPaise: number;
  buyerStateCode: string | null;
  supplierStateCode: string | null;
  buyerCountry: string;
}): ConsumerInvoiceTax {
  const totalPaise = params.totalPaise;
  const taxAmountPaise = params.taxAmountPaise;
  // Never re-derived from a rate: this is the figure the buyer actually paid,
  // and it must agree with the GST_PAYABLE credit settlement posted.
  const taxableValuePaise = totalPaise - taxAmountPaise;

  const buyerState = numericStateCode(null, params.buyerStateCode);
  const supplierState = numericStateCode(null, params.supplierStateCode);

  // Cross-border supply of services: zero-rated only under a live LUT, and
  // taxable at 18% IGST otherwise. That gate already exists and is the single
  // place the LUT is read, so delegate rather than re-implement it, then map
  // the result into this shape.
  if (params.buyerCountry !== "IN") {
    const gst = deriveGstBreakdown({
      subtotalPaise: taxableValuePaise,
      supplierStateCode: params.supplierStateCode,
      buyerStateCode: params.buyerStateCode,
      buyerCountry: params.buyerCountry,
      hsnCode: TAX_CONSTANTS.HSN_CODES.CONSULTING,
    });
    // Take the CLASSIFICATION from the gate (zero-rated under a live LUT, or
    // taxable as IGST without one) but keep the AMOUNTS anchored to what the
    // buyer was charged, so `taxable + heads == total` still holds exactly. A
    // rate-recomputed head would make the document disagree with the payment,
    // and the register's own arithmetic check exists to surface the residual
    // case where an export was charged nothing while no LUT was on file.
    const zeroRated = gst.reason === "ZERO_RATED_EXPORT";
    return {
      taxableValuePaise,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: zeroRated ? 0 : taxAmountPaise,
      totalPaise: zeroRated ? taxableValuePaise : totalPaise,
      placeOfSupply: gst.placeOfSupply,
      placeOfSupplySource: buyerState
        ? "DECLARED_AT_CHECKOUT"
        : "SUPPLIER_DEFAULT_12_2_B",
      reason: gst.reason,
    };
  }

  // s.12(2)(b): no address of the recipient on record ⇒ the supply is placed
  // at the supplier's location, which makes it intra-state.
  const placeOfSupply = buyerState ?? supplierState;
  const intraState = !buyerState || buyerState === supplierState;

  if (intraState) {
    // Deterministic split — floor CGST and let SGST absorb the odd paise, so
    // the two heads sum to the charged tax exactly (same rule as the B2B
    // split, so the two document families never disagree by a paise).
    const cgstPaise = Math.floor(taxAmountPaise / 2);
    return {
      taxableValuePaise,
      cgstPaise,
      sgstPaise: taxAmountPaise - cgstPaise,
      igstPaise: 0,
      totalPaise,
      placeOfSupply,
      placeOfSupplySource: buyerState
        ? "DECLARED_AT_CHECKOUT"
        : "SUPPLIER_DEFAULT_12_2_B",
      reason: buyerState ? "INTRA_STATE_CGST_SGST" : "SUPPLIER_DEFAULT_12_2_B",
    };
  }

  return {
    taxableValuePaise,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: taxAmountPaise,
    totalPaise,
    placeOfSupply,
    placeOfSupplySource: "DECLARED_AT_CHECKOUT",
    reason: "INTER_STATE_IGST",
  };
}

/** Funding sources that make a payment ORG-funded. Those supplies are invoiced
 *  to the organization on its own series and must never get a second document
 *  on the consumer series. */
const ORG_FUNDED_LEG_SOURCES = new Set([
  "WALLET",
  "LICENSE",
  "INVOICE_ACCRUAL",
  "OVERAGE_INVOICE_ACCRUAL",
]);

/**
 * Which record supplied the buyer's state. Recorded on the invoice because a
 * state defaulted under s.12(2)(b) is indistinguishable from a declared
 * home-state supply once it has been written down.
 */
function resolvePlaceOfSupplySource(
  declaredStateCode: string | null,
  profileStateCode: string | null,
): PlaceOfSupplySource {
  if (declaredStateCode) return "DECLARED_AT_CHECKOUT";
  if (profileStateCode) return "PROFILE_ON_RECORD";
  return "SUPPLIER_DEFAULT_12_2_B";
}

let supplierUnconfiguredLogged = false;

/**
 * Mint the statutory tax invoice for one successful consumer payment.
 *
 * Idempotent on `paymentId`: the probe runs BEFORE a number is allocated, so a
 * webhook redelivery re-reads the existing invoice instead of burning a
 * gapless Rule 46 sequence number.
 *
 * Silently no-ops (returns null) rather than throwing, because the callers are
 * booking-confirmation paths: a buyer's confirmed session must never roll back
 * because a document could not be produced. The register export re-attempts
 * every un-invoiced payment monthly, so a no-op here is recoverable.
 *
 * Must run inside a transaction.
 */
export async function mintConsumerInvoice(
  tx: Tx,
  params: { paymentId: string },
): Promise<{ consumerInvoiceId: string | null }> {
  // Probe FIRST — before any sequence allocation (#1365).
  const existing = await tx.consumerInvoice.findUnique({
    where: { paymentId: params.paymentId },
    select: { id: true },
  });
  if (existing) return { consumerInvoiceId: existing.id };

  const payment = await tx.payment.findUnique({
    where: { id: params.paymentId },
    select: {
      id: true,
      amount: true,
      taxAmount: true,
      currency: true,
      paymentStatus: true,
      deletedAt: true,
      buyerCountry: true,
      consumerStateCode: true,
      billableToOrgInvoiceId: true,
      createdAt: true,
      userId: true,
      legs: { select: { source: true } },
      creditUsages: { select: { originalAmount: true } },
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          address: true,
          city: true,
          consulteeProfile: { select: { billingStateCode: true } },
        },
      },
    },
  });

  if (!payment) return { consumerInvoiceId: null };
  if (payment.deletedAt !== null || payment.paymentStatus !== "SUCCEEDED") {
    return { consumerInvoiceId: null };
  }

  // Org-funded supplies are invoiced to the organization, on the org series.
  if (
    payment.billableToOrgInvoiceId !== null ||
    payment.legs.some((leg) => ORG_FUNDED_LEG_SOURCES.has(leg.source))
  ) {
    return { consumerInvoiceId: null };
  }

  const supplier = getPlatformSupplier();
  if (!supplier) {
    // Fail closed and loudly ONCE per process: minting a tax invoice without a
    // real GSTIN is worse than minting none, and the download route already
    // returns an ops-actionable 503 for the same reason.
    if (!supplierUnconfiguredLogged) {
      supplierUnconfiguredLogged = true;
      console.warn(
        JSON.stringify({
          event: "consumer_invoice_supplier_unconfigured",
          reason:
            "PLATFORM_GSTIN is unset or malformed; consumer tax invoices are not being issued.",
        }),
      );
    }
    return { consumerInvoiceId: null };
  }

  // The gateway charge is net of referral credits, but the SUPPLY is the full
  // pre-credit consideration — a platform-issued credit is a discount we fund,
  // not a reduction of the value supplied. Reconstruct it exactly.
  const creditsAppliedPaise = payment.creditUsages.reduce(
    (sum, usage) => sum + usage.originalAmount,
    0,
  );
  const totalPaise = payment.amount + creditsAppliedPaise;
  if (totalPaise <= 0) return { consumerInvoiceId: null };

  const declaredStateCode = payment.consumerStateCode;
  const profileStateCode =
    payment.user.consulteeProfile?.billingStateCode ?? null;
  const buyerStateCode = declaredStateCode ?? profileStateCode;

  const supplierStateCode = process.env.SUPPLIER_STATE_CODE ?? null;
  const tax = deriveConsumerInvoiceTax({
    totalPaise,
    taxAmountPaise: payment.taxAmount,
    buyerStateCode,
    supplierStateCode,
    buyerCountry: payment.buyerCountry ?? "IN",
  });

  // The derivation only knows whether it HAD a buyer state; which record it
  // came from is this function's knowledge.
  const placeOfSupplySource = resolvePlaceOfSupplySource(
    declaredStateCode,
    profileStateCode,
  );

  const issuedAt = new Date();
  const { invoiceNumber, fiscalYear } = await generateConsumerInvoiceNumber(
    tx,
    issuedAt,
  );

  const buyerAddress =
    [payment.user.address, payment.user.city]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(", ") || null;

  const created = await tx.consumerInvoice.create({
    data: {
      paymentId: payment.id,
      userId: payment.userId,
      invoiceNumber,
      fiscalYear,
      supplierName: supplier.name,
      supplierGstin: supplier.gstin,
      supplierAddress: supplier.address,
      // The supplier's own state is authoritative from its GSTIN prefix; the
      // env code is the fallback for the same reason numericStateCode exists.
      supplierStateCode:
        numericStateCode(supplier.gstin, supplierStateCode) ?? "00",
      buyerName: payment.user.name ?? payment.user.email,
      buyerEmail: payment.user.email,
      buyerAddress,
      buyerStateCode: numericStateCode(null, buyerStateCode),
      placeOfSupplySource,
      placeOfSupply: tax.placeOfSupply,
      taxableValuePaise: tax.taxableValuePaise,
      cgstPaise: tax.cgstPaise,
      sgstPaise: tax.sgstPaise,
      igstPaise: tax.igstPaise,
      totalPaise: tax.totalPaise,
      currency: payment.currency,
      sacCode: TAX_CONSTANTS.HSN_CODES.CONSULTING,
      taxRateBps: CONSUMER_TAX_RATE_BPS,
      // The supply happened when the buyer paid, not when we got around to
      // documenting it; `issuedAt` is always now (a back-dated issue date on a
      // gapless series is a Rule 46 breach).
      supplyDate: payment.createdAt,
      issuedAt,
      needsBuyerAddress:
        totalPaise >= RULE_46_ADDRESS_THRESHOLD_PAISE &&
        (buyerAddress === null || buyerStateCode === null),
    },
    select: { id: true },
  });

  return { consumerInvoiceId: created.id };
}

/**
 * Mint the s.34 credit note that reverses part or all of a consumer invoice.
 *
 * Idempotent on the trigger (`refundId` or `disputeId`, both @unique), probed
 * before any number is allocated. No-op when the payment never had a consumer
 * invoice — an org-funded refund is handled by `mintRefundCreditNote` on the
 * org series instead.
 *
 * The reversal is strictly proportional over the tax-INCLUSIVE total, and uses
 * the same tax head the invoice used: a credit note may not move a supply from
 * one head to another.
 */
export async function mintConsumerCreditNote(
  tx: Tx,
  params: {
    paymentId: string;
    amountPaise: number;
    reason: string;
    refundId?: string;
    disputeId?: string;
  },
): Promise<{ consumerCreditNoteId: string | null }> {
  if (Boolean(params.refundId) === Boolean(params.disputeId)) {
    throw new TypeError(
      "mintConsumerCreditNote: exactly one of refundId/disputeId must be set",
    );
  }

  // Probe FIRST, for the same reason the invoice does.
  const existing = await tx.consumerCreditNote.findUnique({
    where: params.refundId
      ? { refundId: params.refundId }
      : { disputeId: params.disputeId! },
    select: { id: true },
  });
  if (existing) return { consumerCreditNoteId: existing.id };

  const invoice = await tx.consumerInvoice.findUnique({
    where: { paymentId: params.paymentId },
    select: {
      id: true,
      taxableValuePaise: true,
      cgstPaise: true,
      sgstPaise: true,
      igstPaise: true,
      totalPaise: true,
    },
  });
  if (!invoice || invoice.totalPaise <= 0) {
    return { consumerCreditNoteId: null };
  }

  // Cap at the invoice: a refund larger than the documented supply (a goodwill
  // top-up, a mis-keyed amount) may not credit more tax than was charged.
  const creditedTotal = Math.min(
    Math.max(params.amountPaise, 0),
    invoice.totalPaise,
  );
  if (creditedTotal <= 0) return { consumerCreditNoteId: null };

  const share = (component: number): number =>
    Math.floor((component * creditedTotal) / invoice.totalPaise);

  const issuedAt = new Date();
  const { creditNoteNumber, fiscalYear } =
    await generateConsumerCreditNoteNumber(tx, issuedAt);

  const created = await tx.consumerCreditNote.create({
    data: {
      creditNoteNumber,
      fiscalYear,
      consumerInvoiceId: invoice.id,
      refundId: params.refundId ?? null,
      disputeId: params.disputeId ?? null,
      reason: params.reason,
      taxableValuePaise: share(invoice.taxableValuePaise),
      cgstPaise: share(invoice.cgstPaise),
      sgstPaise: share(invoice.sgstPaise),
      igstPaise: share(invoice.igstPaise),
      totalPaise: creditedTotal,
      issuedAt,
    },
    select: { id: true },
  });

  return { consumerCreditNoteId: created.id };
}
