/**
 * Tax Engine
 *
 * Centralized tax determination for checkout.
 * Handles GST for domestic (India) and zero-rating for export of services.
 *
 * Legal basis:
 * - Domestic: 18% GST on consulting/education services
 * - Export: Zero-rated under IGST Act Section 2(6) when:
 *   1. Supplier is in India
 *   2. Recipient is outside India
 *   3. Payment is received in convertible foreign exchange
 *   4. Place of supply is outside India
 *   5. Supplier and recipient are not establishments of the same person
 */

import { TAX_CONSTANTS } from "@/lib/payments/payouts/constants";

// ============================================================================
// Types
// ============================================================================

export interface TaxDetermination {
  /** Tax rate as percentage (18 for GST, 0 for export) */
  taxRate: number;
  /** Tax amount in paise */
  taxAmount: number;
  /** Whether this is a zero-rated export */
  isZeroRated: boolean;
  /** Tax jurisdiction identifier */
  jurisdiction: "IN-GST" | "EXPORT-ZERO" | "DEFERRED";
  /** SAC (Service Accounting Code) */
  sacCode: string;
  /** Human-readable note for invoices */
  notes?: string;
}

export type ServiceType = "CONSULTING" | "EDUCATION" | "TRAINING";

// ============================================================================
// Core Tax Logic
// ============================================================================

/**
 * Determine applicable tax based on buyer country and service type.
 *
 * For MVP: India = 18% GST, everywhere else = 0% (export zero-rated).
 * Extensible for EU VAT, AU GST, etc. in future phases.
 */
export function determineTax(params: {
  baseAmountPaise: number;
  buyerCountry: string;
  serviceType?: ServiceType;
}): TaxDetermination {
  const { baseAmountPaise, buyerCountry, serviceType = "CONSULTING" } = params;

  // Domestic India — charge GST
  if (buyerCountry === "IN") {
    const taxRate = TAX_CONSTANTS.GST_RATE;
    const sacCode = getSacCode(serviceType);
    const taxAmount = Math.round((baseAmountPaise * taxRate) / 100);

    return {
      taxRate,
      taxAmount,
      isZeroRated: false,
      jurisdiction: "IN-GST",
      sacCode,
    };
  }

  // International — zero-rated export of services
  // TODO: For production tax-defense, capture additional evidence per payment:
  // billing address, gateway-confirmed remittance country, FIRC/eFIRC reference,
  // LUT state at invoice time, and stored reason code for zero-rating.
  return {
    taxRate: 0,
    taxAmount: 0,
    isZeroRated: true,
    jurisdiction: "EXPORT-ZERO",
    sacCode: getSacCode(serviceType),
    notes: "Export of services — Zero-rated under IGST Act Section 2(6)",
  };
}

/**
 * Get the SAC (Service Accounting Code) for a service type.
 */
function getSacCode(serviceType: ServiceType): string {
  switch (serviceType) {
    case "CONSULTING":
      return TAX_CONSTANTS.HSN_CODES.CONSULTING;
    case "EDUCATION":
      return TAX_CONSTANTS.HSN_CODES.EDUCATION;
    case "TRAINING":
      return TAX_CONSTANTS.HSN_CODES.TRAINING;
    default:
      return TAX_CONSTANTS.SAC_CODE;
  }
}

/**
 * Map appointment type to service type for tax purposes.
 */
export function appointmentTypeToServiceType(
  appointmentType: string,
): ServiceType {
  switch (appointmentType) {
    case "CONSULTATION":
    case "SUBSCRIPTION":
      return "CONSULTING";
    case "WEBINAR":
    case "CLASS":
      return "EDUCATION";
    default:
      return "CONSULTING";
  }
}
