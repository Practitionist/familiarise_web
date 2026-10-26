/**
 * Platform supplier identity for statutory documents (tax invoices, credit
 * notes, IRP payloads). The name and address are the legal entity in
 * `lib/company.ts`; only the GSTIN is deployment config.
 */

import { isValidGstin } from "@/lib/compliance/gst";
import { COMPANY_INFO } from "@/lib/company";
import { billingEmail } from "@/lib/email/config";

export interface PlatformSupplier {
  name: string;
  gstin: string;
  address: string;
  email: string;
}

/**
 * The supplier identity, or null when PLATFORM_GSTIN is unset or malformed.
 * Fail-closed: callers choose their own refusal (a 503 on a download route,
 * a skipped IRP run) rather than mint a document without a real GSTIN.
 */
export function getPlatformSupplier(): PlatformSupplier | null {
  const gstin = process.env.PLATFORM_GSTIN?.trim();
  if (!gstin || !isValidGstin(gstin)) return null;
  return {
    name: COMPANY_INFO.name,
    gstin,
    address: COMPANY_INFO.registeredAddress,
    email: billingEmail(),
  };
}
