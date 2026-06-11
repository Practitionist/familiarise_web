/**
 * India compliance barrel.
 *
 * Status as of 2026-05-02 (after #738 Round 2):
 *   - tds.ts          — DTAA + section selection live; rate constant
 *                       still being normalised (see compliance docs 01).
 *   - msme.ts         — `computeMsmePaymentDeadline` live (15/45-day rule).
 *   - gst.ts          — `deriveGstBreakdown` live (CGST/SGST/IGST split).
 *   - irp.ts          — env-gated ClearTax connector (production-approval
 *                       still pending).
 *   - dpdp.ts         — `buildConsentArtifact` live; `checkConsent` still
 *                       a stub (returns true). #701 owns the cascade.
 *   - form15.ts       — schema-only; cross-border remittance refs not
 *                       yet captured. See compliance doc 07.
 *
 * The full live-implementation plan lives in:
 *
 *   docs/compliance/13-implementation-roadmap.md
 *
 * Callers MUST treat any function that is still flagged as a stub
 * ("checkConsent", "form15.*") as "sensible default, safe but not
 * compliant" and NOT rely on it for:
 *   - Audit-ready filings
 *   - Real consent enforcement
 *   - Cross-border remittance approvals
 *
 * See each module's header docblock for live-implementation status.
 */

export * from "./tds";
export * from "./msme";
export * from "./gst";
export * from "./irp";
export * from "./dpdp";
export * from "./form15";
