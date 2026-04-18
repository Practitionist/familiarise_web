# India Compliance Stubs — Implementation Plan

**Status:** Authoritative checklist for Phase 2b follow-up PRs (April 2026)

This is the **master reference** for every India-compliance stub in
`lib/compliance/**` and every cron in `jobs/compliance/**`. Each entry
documents exactly what to wire up, in what order, and what the contract
is with callers.

---

## Quick inventory

| File | Status | Owns | Phase-2b PR |
|---|---|---|---|
| `lib/compliance/tds.ts` | STUB | 194J/194O/194C derivation, PAN validation, 206AA fallback, DTAA | `feature/india-tds` |
| `lib/compliance/msme.ts` | STUB | Section 43B(h) 15/45-day deadline calculator | `feature/india-msme` |
| `lib/compliance/gst.ts` | STUB (real SHA-256) | Place-of-supply, IGST vs CGST+SGST split, HSN defaulting, GSTIN validation | `feature/india-gst` |
| `lib/compliance/irp.ts` | STUB | IRN generation via IRIS / ClearTax connector | `feature/india-irn` |
| `lib/compliance/dpdp.ts` | STUB (real SHA-256) | ConsentArtifact hashing, 7-year retention | `feature/india-dpdp` |
| `lib/compliance/form15.ts` | STUB | Form 15CA Part C + 15CB cross-border refs | `feature/india-fema` |
| `jobs/compliance/irp-uploader.ts` | STUB | Daily cron: upload pending IRNs within 30-day window | part of `feature/india-irn` |
| `jobs/compliance/msme-payment-alerts.ts` | STUB | Daily cron: surface payouts ≤5 days from 43B(h) deadline | part of `feature/india-msme` |
| `jobs/compliance/consent-retention-sweeper.ts` | STUB | Weekly cron: purge ConsentArtifacts past 7-year retention | part of `feature/india-dpdp` |
| `jobs/billing/generate-subscription-invoices.ts` | REAL | Daily cron: BillingSubscription → OrganizationInvoice + SettlementLedger | already shipped |

---

## Recommended rollout order

### 1. `feature/india-tds` (unblocks PROVIDER payouts)

- **Schema:** no changes (fields already on `ConsultantProfile` +
  `OrganizationPayout`).
- **Impl targets:**
  - `computeTdsForPayout({ grossAmountPaise, consultant })`
      - **Section selection:** 194-O if consultant is sourced via the
        platform; 194J for independent professional services; 194C for
        pure contractor.
      - **PAN check** via `isValidPan`. Missing/invalid → 206AA 20% fallback.
      - **DTAA lookup** for `residencyStatus=NON_RESIDENT` — cross-reference
        `providerCountry` against DTAA schedule JSON (ship the schedule as
        a const). DTAA rate applies only with Form 10F + TRC (both off-
        schema today; add `ConsultantProfile.form10FRef` / `trcRef` then).
  - **Quarterly TDS return**: separate batch job (Form 26Q / 27Q) —
    consume from `Payout` rows with `tdsAmountPaise > 0`. Not this PR.
- **Tests:** unit tests on computeTdsForPayout cover:
    - 194J default (10%)
    - 194O override (1%)
    - 206AA fallback (20%)
    - DTAA reduction (e.g. US treaty 15%)
    - missing consultant.tdsSection (falls through to 194J default)

### 2. `feature/india-msme` (unblocks 43B(h) compliance)

- **Schema:** no changes (`msmeStatus`, `udyamNumber`,
  `writtenAgreementWithFamiliarise` already on `ConsultantProfile`).
- **Impl targets:**
  - `computeMsmePaymentDeadline({ invoiceDate, msmeStatus,
    writtenAgreement, defaultTermsDays })`
      - `MICRO` or `SMALL` with written agreement → 45 days.
      - `MICRO` or `SMALL` without written agreement → 15 days.
      - `MEDIUM` or `NONE` → `defaultTermsDays` (60 for India).
  - `isValidUdyamNumber` regex check.
  - Cron `msme-payment-alerts.ts`: query `OrganizationPayout` where
    `mustPayByDate` is within 5 days and `status != SUCCEEDED`; post
    to an admin dashboard + email finance team.
- **Tests:** table-driven unit tests for every combination.

### 3. `feature/india-gst` (unblocks invoice finality)

- **Schema:** no changes.
- **Impl targets:**
  - `resolvePlaceOfSupply` — uses the supplier state (`KA` for
    Bengaluru-registered Familiarise) vs buyer. Export/import returns null.
  - `deriveGstBreakdown` — IGST vs CGST+SGST based on state equality.
  - HSN code autofill: 999293 default (educational/consulting); override
    at plan level if catalog plans carry distinct HSN later.
  - `isValidGstin` — full 15-char regex + checksum byte.
- **Tests:** intra-state (CGST+SGST), inter-state (IGST), export (zero),
  reverse-charge import (RCM true, 0 tax, buyer liable).

### 4. `feature/india-irn` (unblocks enterprise buyer acceptance)

- **Schema:** no changes.
- **Impl targets:**
  - Ship BOTH IRIS + ClearTax connectors behind a feature flag;
    default = ClearTax (cheaper integration path in pilot).
  - `generateIrn` success populates `irn`, `ackNumber`, `ackDate`,
    `signedQrPayload`, sets `irpStatus=GENERATED`.
  - `cancelIrn` enforces 24-hour window; after that, caller must issue a
    credit note + new invoice.
  - Cron `irp-uploader.ts`: batch of 50, retries failures up to 3× over
    30 days then surfaces to admin dashboard.
- **Ops:** document DSC (Digital Signature Certificate) setup, sandbox
  creds rotation.

### 5. `feature/india-dpdp` (unblocks SDF designation)

- **Schema:** no changes, but add `User.dpdpStatus: UNDER_18 | ADULT |
  GUARDIAN_VERIFIED` when targeting students.
- **Impl targets:**
  - Multi-language notice renderer: Schedule VIII 22 languages.
  - Withdrawal flow: `withdrawnAt` populated; downstream processors
    check latest grant.
  - Cron `consent-retention-sweeper.ts`: actually purge past 7-year
    retention. Keep hashed-only audit copy in a separate `ConsentAuditCopy`
    table (schema P2; add with this PR).
  - DataBreach 72-hour reporting flow: admin-triggered create, auto-email
    `dpb@meity.gov.in` + banner on affected users' dashboards.
- **SDF designation:** monitor active-user threshold; flip the
  `isSignificantDataFiduciary` org-level flag (schema P2; add before
  hitting 1M users).

### 6. `feature/india-fema` (unblocks cross-border consultants)

- **Schema:** already has Form 15CA/15CB refs + FIRCE + RBI purpose code
  on `OrganizationPayout`. Add `ConsultantProfile.form10FRef` +
  `trcRef` in this PR for DTAA prerequisites.
- **Impl targets:**
  - `prepareForm15References` — integrates with a CA partner (Taxmann
    or TaxSpanner) for 15CB UDIN capture.
  - 15CA Part C filing via the income-tax.gov.in e-filing API (DSC
    required, same as IRP).
  - AD-bank integration for FIRCE capture on inward; ORC for outward.
- **Cross-border toggle:** `Organization.isGCC` gates the full flow; for
  `providerCountry != "IN"` + non-GCC, block payout until Form 15
  refs are populated.

---

## What the stubs actually return today

Every stub has a TODO in its header; runtime behaviour:

| Function | Current return |
|---|---|
| `computeTdsForPayout` | `{ tdsSection: "194J", tdsRate: 0.10, tdsAmountPaise: 0, … }` |
| `isValidPan` | real regex check |
| `computeMsmePaymentDeadline` | `invoiceDate + defaultTermsDays` (no 15/45 distinction) |
| `isValidUdyamNumber` | real regex check |
| `deriveGstBreakdown` | zero tax returned; `placeOfSupply = buyerStateCode` |
| `isValidGstin` | real regex (no checksum) |
| `resolvePlaceOfSupply` | `buyerStateCode` for IN buyers, null for export |
| `generateIrn` | `{ irn: null, status: "FAILED", reason: "STUB" }` |
| `cancelIrn` | `{ cancelled: false }` |
| `buildConsentArtifact` | **real** — SHA-256 hash + 7-year retention date |
| `checkConsent` | always `true` |
| `prepareForm15References` | all nulls |

Callers see "everything is fine" — but no withholding, no IRP upload,
no consent enforcement. Safe for pilot customers with manual off-platform
compliance; **not safe for production-audit revenue**.

---

## Verification after each PR

Each Phase-2b PR must ship with:
1. Unit tests covering ≥90% of the new lib function
2. Integration test against a real sandbox (IRIS sandbox, income-tax.gov.in
   sandbox, Razorpay payout sandbox)
3. Admin-dashboard reconciliation view for the affected entity
4. Runbook in `docs/runbooks/compliance-{irp,tds,msme,dpdp,fema}.md`

No compliance implementation lands without a runbook.
