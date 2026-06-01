# Compliance: GST · TDS · MSME · DPDP (enterprise touchpoints)

**What this covers:** where the enterprise subsystem *touches* India statutory compliance, and the journal/schema hooks behind each. This is the **enterprise-side map**; the authoritative rules, rates, thresholds, and roadmap live in [`../compliance/`](../compliance/00-overview.md) — this doc links out rather than restating tax law.

> **Division of labour.** `docs/compliance/*` owns the regulatory obligation (what the law requires). This doc owns the wiring (which model/posting/cron implements it on the enterprise side). When they disagree, the compliance docs win on *rules*, the code wins on *behaviour*.

---

## 1. GST (output tax on bookings & invoices)

- **Where it posts.** Every booking credits `GST_PAYABLE` with `Payment.taxAmount` ([ledger & postings](08-ledger-and-postings.md) §4.2); a refund reverses the prorated GST share (§4.7). `GST_PAYABLE` is a platform liability — collected, owed to the government until remitted.
- **Invoice breakdown.** `OrganizationInvoice` carries `igstPaise` / `cgstPaise` / `sgstPaise`, derived by `deriveGstBreakdown()` (`lib/compliance/gst.ts`) from place-of-supply (`Organization.gstStateCode`) — intra-state splits CGST+SGST, inter-state is IGST. See [invoicing](12-invoicing.md).
- **e-invoice / IRN.** `OrganizationInvoice.irn` + `irpStatus` are schema-final; the IRP uploader (`lib/compliance/irp.ts`) is **stubbed** for v1.
- **Detail:** [`../compliance/02-gst-overview.md`](../compliance/02-gst-overview.md).

## 2. TDS (tax withheld at payout)

- **Where it posts.** Both payout flows withhold TDS: `Dr *_PAYABLE (net+TDS) / Cr CASH (net) / Cr TDS_PAYABLE (withheld)` — consultant ([§4.4](08-ledger-and-postings.md)) and host-org ([§4.5](08-ledger-and-postings.md)). `OrganizationPayout`/`ConsultantPayout` persist `tdsSectionApplied`, `tdsAmountPaise`, and rate snapshots; `TDSRecord` rows back Form 26Q.
- **Detail (and the known rate caveats):** [`../compliance/01-tds-overview.md`](../compliance/01-tds-overview.md), [`../compliance/04-tds-quarterly-filings.md`](../compliance/04-tds-quarterly-filings.md). Refund/chargeback tax reversal: [`../compliance/05-refund-and-chargeback-tax-adjustments.md`](../compliance/05-refund-and-chargeback-tax-adjustments.md).

## 3. MSME 43B(h) (15/45-day payment clearance)

- **Where it lives.** `OrganizationMsmeInfo { msmeStatus, msmeWrittenAgreementOnFile }` classifies a host org; `OrganizationPayout.mustPayByDate` carries the derived statutory deadline (`computeMsmePaymentDeadline`, `lib/compliance/msme.ts`).
- **Detail:** [`../compliance/03-msme-43b-h.md`](../compliance/03-msme-43b-h.md).

## 4. DPDP 2023 (consent, erasure, retention)

- **Where it lives.** `ConsentArtifact` (purpose codes, grant/withdraw timestamps, SHA-256 tamper-evident hash, `auditRetainedUntil`); erasure scrubs PII via `lib/compliance/erasure/scrub-user.ts` while `lib/enterprise/audit-sanitize.ts` pseudonymizes audit rows. Ledger rows are **never** deleted (immutable; financial-retention) — erasure pseudonymizes the actor, not the money. See [deletion policy](31-deletion-policy.md).
- **Detail:** [`../compliance/08-dpdp-and-privacy.md`](../compliance/08-dpdp-and-privacy.md).

## 5. Other rails

| Topic | Enterprise hook | Detail |
| --- | --- | --- |
| RBI PA / payment architecture | wallet is a prepaid liability, not custody; payouts via provider float | [`../compliance/10-rbi-pa-and-payment-architecture.md`](../compliance/10-rbi-pa-and-payment-architecture.md) |
| Cross-border (Sec 195, 15CA/CB) | `OrganizationPayout.form15caPartCRef` / `form15cbRef` (schema-final, stubbed) | [`../compliance/07-cross-border-flows.md`](../compliance/07-cross-border-flows.md) |
| Consumer protection / grievance | refund SLA, grievance officer | [`../compliance/09-consumer-protection-and-grievance.md`](../compliance/09-consumer-protection-and-grievance.md) |
| Compliance calendar & roadmap | recurring filing cadence | [`../compliance/12-india-compliance-calendar.md`](../compliance/12-india-compliance-calendar.md), [`../compliance/13-implementation-roadmap.md`](../compliance/13-implementation-roadmap.md) |

---

### Related docs
- [Payout pipeline](11-payout-pipeline.md) — TDS/MSME fields in the payout flow.
- [Invoicing](12-invoicing.md) — GST breakdown + IRN.
- [Ledger & postings](08-ledger-and-postings.md) — `GST_PAYABLE` / `TDS_PAYABLE` legs.
- [`../compliance/00-overview.md`](../compliance/00-overview.md) — the compliance index (authoritative).
