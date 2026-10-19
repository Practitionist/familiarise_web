/**
 * The dispute's human-facing reference.
 *
 * A dispute is 1:1 with a case, and the case already carries a speakable,
 * year-scoped, allocated reference (`FAM-2026-000123`). The dispute reuses
 * that series with its own prefix, so the two identifiers line up: a customer
 * who says "my case is FAM-2026-000123" and a support agent who says "your
 * dispute is DSP-2026-000123" are talking about the same thing.
 *
 * Deriving it rather than running a second counter keeps the number unique
 * (the case's number is unique), keeps the series unbroken, and means the
 * two numbers can never drift apart.
 */

const CASE_REFERENCE_PATTERN = /^FAM-(\d{4})-(\d{6})$/;

export const DISPUTE_REFERENCE_PREFIX = "DSP";

export function disputeReferenceFromCase(caseReference: string): string {
  const match = CASE_REFERENCE_PATTERN.exec(caseReference);
  if (!match) {
    throw new Error(
      `A dispute reference is derived from a case reference, and "${caseReference}" is not one.`,
    );
  }
  return `${DISPUTE_REFERENCE_PREFIX}-${match[1]}-${match[2]}`;
}

/** The case reference a dispute reference belongs to. */
export function caseReferenceFromDispute(disputeReference: string): string {
  const match = new RegExp(`^${DISPUTE_REFERENCE_PREFIX}-(\\d{4})-(\\d{6})$`).exec(
    disputeReference,
  );
  if (!match) {
    throw new Error(
      `"${disputeReference}" is not a dispute reference (expected DSP-YYYY-NNNNNN).`,
    );
  }
  return `FAM-${match[1]}-${match[2]}`;
}

export function isDisputeReference(value: string): boolean {
  return new RegExp(`^${DISPUTE_REFERENCE_PREFIX}-\\d{4}-\\d{6}$`).test(value);
}
