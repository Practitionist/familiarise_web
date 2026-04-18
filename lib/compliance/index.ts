/**
 * India compliance barrel.
 *
 * Every export here is STUBBED in v1 (Arch 4-Modified). The schema fields
 * they serialize to (GSTIN/TDS/MSME/IRN/DPDP/FEMA) are FINAL — the
 * live-implementation plan lives in:
 *
 *   docs/compliance/india/07-stubs-and-implementation-plan.md
 *
 * Callers MUST treat stub return values as "sensible defaults, safe but
 * not compliant" and NOT rely on them for:
 *   - Audit-ready filings
 *   - IRP-registered invoices
 *   - TDS withholdings
 *   - Real consent enforcement
 *   - Cross-border remittance
 *
 * See each stub's header docblock for live-implementation requirements.
 */

export * from "./tds";
export * from "./msme";
export * from "./gst";
export * from "./irp";
export * from "./dpdp";
export * from "./form15";
