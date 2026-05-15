# India compliance — P0/P1 shipping checklist

**Audit date:** 2026-05-15
**Scope:** B2B (enterprise) subsystem only — B2C parallel work in a separate PR.

This file is the single shipping checklist that aggregates across the
14 compliance docs in this directory. It supersedes the per-document
P0/P1 lists. Every item is graded against three thresholds: **MUST** for
the design-partner merge, **WHEN-ASKED** by the first enterprise buyer,
or **DEFER** indefinitely. Compliance is not over-engineered — every
MUST item is the actual law of the land in 2026.

---

## §1 — MUST ship in this PR (legally mandatory before design-partner merge)

| # | Item | Status | File:line evidence |
|---|---|---|---|
| 1.1 | **TDS withholding wired into org payouts** — Section 194-O default (1%), Section 206AA 20% PAN fallback. `tdsAmountPaise` deducted from gross before gateway dispatch; `tdsSectionApplied`, `dtaaRateApplied` persisted on `OrganizationPayout`. | ✅ This PR | `lib/payments/payouts/org-payout-service.ts` (createOrgPayoutBatch tx); `lib/compliance/tds.ts` (canonical lib) |
| 1.2 | **MSME 43B(h) deadline tracking on org payouts** — `mustPayByDate` derived from `Organization.msmeStatus` + `msmeWrittenAgreementOnFile`, not a hardcoded `NONE` stub. | ✅ This PR | `lib/payments/payouts/org-payout-service.ts`; `lib/compliance/msme.ts`; schema `Organization.msmeStatus`/`msmeWrittenAgreementOnFile` |
| 1.3 | **DPDP consent stamping at signup + Stream gate** — essential-purpose `ConsentArtifact` written in the BetterAuth `user.create.after` hook; `STREAM_DATA_PROCESSING` gate refuses Stream upsert when consent absent. | ✅ This PR | `lib/auth.ts` (user.create.after hook); `actions/stream/chat/user.action.ts` (`checkConsent` gate, single + batch) |
| 1.4 | **GST place-of-supply state code is env-driven** — `SUPPLIER_STATE_CODE` env replaces hardcoded `"KA"`. Place-of-supply rules pick CGST+SGST vs IGST correctly when business address changes. | ✅ This PR | `.env.sample`; `jobs/billing/generate-subscription-invoices.ts`; `app/api/organizations/[orgId]/billing-account/invoices/route.ts` |
| 1.5 | **Per-org sequential invoice numbering (CGST Rule 46)** — atomic counter table `org_invoice_counters`, `INSERT ON CONFLICT DO UPDATE RETURNING`, format `<PREFIX>-<FY>-<SEQ>`, unbroken sequence per (org, fiscal year). | ✅ This PR | `lib/payments/billing/invoice-numbering.ts`; schema `OrgInvoiceCounter`, `OrganizationInvoice.fiscalYear`, `@@unique([organizationId, invoiceNumber])` |
| 1.6 | **IRP / IRN upload cron live + creds-gated** — daily 02:30 UTC; ClearTax connector live; sub-₹5cr orgs accept `FAILED`/`PENDING` until they cross AATO. | ✅ Already shipped (Round 2) | `jobs/compliance/irp-uploader.ts`; `.github/workflows/irp-uploader.yml`; `lib/compliance/irp.ts` |
| 1.7 | **DPDP 72-hour breach alert cron** — hourly sweep + Resend / structured-log fallback for `DataBreach WHERE reportedAt IS NULL`. | ✅ Already shipped (Round 2) | `jobs/compliance/databreach-deadline-alerts.ts`; `.github/workflows/databreach-deadline-alerts.yml` |
| 1.8 | **GST derivation (CGST/SGST/IGST)** — zero-rated export, intra-state CGST 9% + SGST 9%, inter-state IGST 18%; live in app. | ✅ Already shipped (Round 2) | `lib/compliance/gst.ts:deriveGstBreakdown` |
| 1.9 | **MSME payment-alert cron** — daily 04:30 UTC; alerts on overdue MSME payouts. | ✅ Already shipped (Round 2) | `jobs/compliance/msme-payment-alerts.ts`; `.github/workflows/msme-payment-alerts.yml` |
| 1.10 | **Contract expiry cron** — daily 03:00 UTC; ACTIVE → EXPIRED on `effectiveTo` cross. | ✅ Already shipped | `jobs/compliance/contract-expiry.ts`; `.github/workflows/expire-contracts.yml` |

---

## §2 — WHEN-ASKED — next 2–4 weeks (post-merge follow-ups)

| # | Item | Why deferred | Ship when |
|---|---|---|---|
| 2.1 | **Quarterly TDS returns (Form 26Q / 27Q)** — generate the return file with consultant-wise reconciliation. | Filing-season runway is Jul (Q1 FY) — not blocking design-partner merge. | Before Jul 7 FY-end filing. CA-assisted automation. |
| 2.2 | **DPDP DSAR export endpoints** — user data export + erasure (right-to-correction, right-to-erasure under §11). | Stub paths exist (`/api/users/[id]/data-export` is a placeholder). | When first user requests under DPDP §11 or after first enterprise buyer's DPA audit. |
| 2.3 | **In-app consent withdrawal UI** — settings page surfacing `ConsentArtifact` purpose codes, allowing revoke. | API already exists at `/api/organizations/[orgId]/consent`; only UI is missing. | Before public DPDP rules effective-date enforcement (rules-stage now; phased rollout 2025-26). |
| 2.4 | **GSTIN registry verify** — replace 15-char regex with live GSTN portal lookup. | Audit-trail only; no immediate filing impact. | After first invoice dispute. |
| 2.5 | **Place-of-supply state capture in B2C checkout** — needed for B2C tax math parity (B2C in separate PR). | Tracked in parallel B2C compliance PR. | When B2C compliance PR opens. |
| 2.6 | **HSN selection logic** — 999293 vs 999299 split based on service type (currently 999293 catch-all). | CA hasn't flagged a real classification dispute. | After GST audit by CA, ideally before first ITC dispute. |
| 2.7 | **Invoice-fraud mitigation** — session-level immutability guards on INVOICE-funded orgs; soft-delete audit. | Manual ops sufficient pre-design-partner. | Before multi-tenant self-serve. |

---

## §3 — DEFER indefinitely (no current requirement)

| # | Item | Justification |
|---|---|---|
| 3.1 | **FEMA Form 15CA / 15CB** | No non-resident consultants on platform yet. Fields exist in `OrganizationPayout` schema; populate manually when first cross-border payout ships. |
| 3.2 | **FIRC + RBI PA-CB compliance** | Same — domestic-only today. |
| 3.3 | **SOC 2 Type II certification** | First enterprise buyer's procurement will ask; 6-month effort. Hold until concrete ask. |
| 3.4 | **ISO 27001 prep** | Less common ask in India B2B. Defer past SOC 2. |
| 3.5 | **Programs v2 runtime (PROJECT, RETAINER, AOR, EOR)** | Enum values reserved; API returns 400 `PROGRAM_TYPE_NOT_AVAILABLE`. Wait for design-partner demand. |
| 3.6 | **Multi-currency on BillingAccount / Invoice / Payout** | INR-only today. Open separate epic with ExchangeRateSnapshot model when first cross-border B2B buyer signs. |
| 3.7 | **Custom RBAC (CustomRole + Permission tables)** | Fixed `MemberRole` enum sufficient for design partners. |
| 3.8 | **SCIM 2.0 provisioning** | `/api/.../scim/*` placeholder returns 501. Wait for SCIM-aware IdP-demanding buyer. |
| 3.9 | **Consumer Protection Grievance Officer UI** | Minimal compliance: contact page + email intake suffices for MVP under 30-day resolution rule. |

---

## §4 — Sign-off slots

| Reviewer | Item set | Sign-off (date / initials) |
|---|---|---|
| Finance lead | §1.1 (TDS), §1.2 (MSME), §1.4 (GST PoS), §1.5 (numbering) | _____________ |
| DPDP officer | §1.3 (consent), §1.7 (breach cron) | _____________ |
| CA (chartered accountant) | §1.1, §1.5, §1.6 (IRP), §1.8 (GST split) | _____________ |
| Engineering lead | All §1 items + Phase 0 schema-DB sync | _____________ |

---

## Notes

- The deprecated `lib/payments/tax/tds-service.ts` (Section 194J flat 10%)
  remains in the tree marked `@deprecated`. Delete in a follow-up PR
  after both pipelines (consultant + org) soak on the canonical
  `lib/compliance/tds.ts` for 2 weeks.
- `Organization.gstStateCode` is the buyer state; `SUPPLIER_STATE_CODE`
  env is the seller (Familiarise) state. Don't conflate.
- DPDP consent is fail-closed for `STREAM_DATA_PROCESSING`. A user who
  has explicitly withdrawn that consent will be silently dropped from
  Stream channel upserts; surface this clearly in any new UX that
  depends on chat/video so users don't see "stuck loading" symptoms.
