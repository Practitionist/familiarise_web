/**
 * Platform supplier identity for statutory documents (tax invoices, credit
 * notes, IRP payloads). The name and address are the legal entity in
 * `lib/company.ts`; only the GSTIN is deployment config.
 */

import { isValidGstin } from "@/lib/compliance/gst";
import { numericStateCode } from "@/lib/compliance/state-codes";
import { COMPANY_INFO, REGISTERED_OFFICE } from "@/lib/company";
import { billingEmail } from "@/lib/email/config";

export interface PlatformSupplier {
  name: string;
  gstin: string;
  address: string;
  email: string;
}

/** The refusal every statutory-document reader answers when `getPlatformSupplier()` is null. */
export const SUPPLIER_UNAVAILABLE_MESSAGE =
  "PLATFORM_GSTIN is unset, malformed, or registered in a state other than the registered office; the platform cannot issue statutory documents.";

/** PLATFORM_GSTIN when it is well-formed, whatever its state. */
export function configuredGstin(): string | null {
  const gstin = process.env.PLATFORM_GSTIN?.trim();
  return gstin && isValidGstin(gstin) ? gstin : null;
}

/**
 * PURE. The supplier's own GST state: the GSTIN's first two digits, which are
 * the state of registration by law, or the registered office's while no GSTIN
 * is set. A GSTIN from another state contradicts the address every document
 * prints, so it resolves to no state and the caller refuses.
 */
export function resolveSupplierStateCode(
  gstin: string | null | undefined,
  registeredStateCode: string,
): {
  stateCode: string | null;
  mismatch: { fromGstin: string; registered: string } | null;
} {
  const fromGstin = numericStateCode(gstin, null);
  const registered = numericStateCode(null, registeredStateCode);
  if (fromGstin && registered && fromGstin !== registered) {
    return { stateCode: null, mismatch: { fromGstin, registered } };
  }
  return { stateCode: fromGstin ?? registered, mismatch: null };
}

/**
 * The supplier identity, or null when PLATFORM_GSTIN is unset, malformed, or
 * from a state other than the registered office's. Fail-closed: every GST
 * document reader refuses (a 503, a skipped run) rather than mint one.
 */
export function getPlatformSupplier(): PlatformSupplier | null {
  const gstin = configuredGstin();
  if (!gstin) return null;
  if (resolveSupplierStateCode(gstin, REGISTERED_OFFICE.stateCode).mismatch) {
    return null;
  }
  return {
    name: COMPANY_INFO.name,
    gstin,
    address: COMPANY_INFO.registeredAddress,
    email: billingEmail(),
  };
}

/** True when PLATFORM_GSTIN is a valid GSTIN from the registered office's state: the platform charges GST. */
export function isPlatformGstRegistered(): boolean {
  return getPlatformSupplier() !== null;
}

/**
 * The supplier for a GST job: null while PLATFORM_GSTIN is unset (pre-registration,
 * a config skip); throws when it is set but malformed or from another state.
 */
export function platformSupplierForJob(): PlatformSupplier | null {
  if (!process.env.PLATFORM_GSTIN?.trim()) return null;
  const supplier = getPlatformSupplier();
  if (!supplier) throw new Error(SUPPLIER_UNAVAILABLE_MESSAGE);
  return supplier;
}
