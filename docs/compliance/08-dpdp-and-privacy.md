# 08 — DPDP Act 2023 + Rules 2025 — data privacy

> **Status:** ✅ DataBreach 72-hour deadline cron live (Round 2, 2026-05-02); ✅ ConsentArtifact schema with SHA-256 hash + 7-year retention; ✅ org-side consent endpoint live; 🔴 consumer-side consent at signup, DSAR endpoints, erasure cascade, retention sweeper all missing; 🔴 multilingual notices missing.
> **Audience:** auth, signup, consent, account-settings code; admin compliance dashboard.
> **Last reviewed:** 2026-05-02
> **Linked issues:** [#737 §3, §4](https://github.com/Practitionist/familiarise_web/issues/737), [#701](https://github.com/Practitionist/familiarise_web/issues/701) (org consent + DataBreach UI epic), [#738](https://github.com/Practitionist/familiarise_web/issues/738).

## What it is

The Digital Personal Data Protection Act 2023, with Rules notified by MeitY on **13 Nov 2025** (G.S.R. 846(E)). Applicable to any digital personal data processed in India.

**Phased rollout:**

| Phase | Deadline | What's enforceable |
|---|---|---|
| **Phase 1** | Immediate (done) | Data Protection Board operational |
| **Phase 2** | **13 Nov 2026** | Consent Manager framework live |
| **Phase 3** | **13 May 2027** | All substantive obligations enforceable: consent, notice, rights, breach, retention |

**Key obligations on a Data Fiduciary (us):**

| # | Obligation | Detail |
|---|---|---|
| 1 | **Granular consent at signup** | Itemised purposes (booking, payment, recordings, marketing, analytics) — each independently toggleable. Plain English + 22 Schedule VIII languages. |
| 2 | **Withdrawal mechanism** | One-click revocation; cascade to revoke downstream processing. |
| 3 | **Data principal rights** | Access, correction, erasure, grievance, nomination — endpoints with response SLAs. |
| 4 | **Verifiable parental consent** | For users under 18; age-gate at signup. |
| 5 | **Retention limits** | Auto-erasure per Rule 8 — e.g., 3-year inactivity rule for e-commerce / social media / online gaming with > 2 cr users. |
| 6 | **Breach reporting** | "Without delay" to DPB + affected users. Currently 72-hour cap is the operational target. |
| 7 | **DPO appointment** | If "Significant Data Fiduciary" (designated by govt — typically based on volume). |
| 8 | **Grievance officer** | Public-facing contact; acknowledge in 24 hr, resolve in 7 days (DPDP) — **separate** from the Consumer Protection officer (see [doc 09](./09-consumer-protection-and-grievance.md)). |

## When it applies

### B2C (consumer marketplace)

- **Applies on every consumer signup, every booking, every recording, every refund.** No exceptions.
- Currently consumer signup at `app/auth/signup/page.tsx` has **no granular consent** — just email/password.
- Privacy policy page exists at `app/(pages)/privacy/page.tsx` but isn't linked from a consent gate.

### B2B (org-sponsored)

- **Applies on org member signup, on org operator data, on consultant onboarding.**
- Org-side `ConsentArtifact` schema + endpoint at `app/api/organizations/[orgId]/consent/route.ts` exists. Consents are typically captured at the org level (org consents on behalf of members for purposes like attendance recording, video sessions).
- Operators (OWNER, MAINTAINER, etc.) need their own consent for org-admin processing.

### Consultants

- Same as B2C consumers for personal-data processing.
- Plus profession-specific data (PAN, GSTIN, bank details, Aadhaar masked) which the platform processes for tax-compliance purposes — has its own purpose code ("payout disbursement + statutory reporting") with retention extending to 7 years post-account-closure (TDS / GST audit trail).

## Current code

| Item | What it does | State |
|---|---|---|
| `ConsentArtifact` (schema) | Per-user consent record with SHA-256 hash, retention-until date, withdrawnAt, language | ✅ schema-final |
| `lib/compliance/dpdp.ts:buildConsentArtifact` | Builds the hash + 7-year retention | ✅ live |
| `lib/compliance/dpdp.ts:checkConsent` | **Always returns `true`** — stub | 🔴 |
| Org-side consent endpoint at `app/api/organizations/[orgId]/consent/route.ts` | Org operator consents | ✅ |
| Consumer-side consent at signup | **Missing** — no checkbox, no granular purposes | 🔴 |
| Consumer DSAR endpoints (access / correction / erasure / grievance / nomination) | **Missing** | 🔴 |
| `DataBreach` (schema) | 72-hour reporting fields | ✅ |
| `jobs/compliance/databreach-deadline-alerts.ts` | Hourly cron, emails DPDP officer for breaches near/past 72h | ✅ live (Round 2) |
| Consent withdrawal cascade | **Missing** — `withdrawnAt` flag exists but no downstream revocation | 🔴 |
| Retention-sweeper cron | **Missing** | 🔴 |
| Multilingual notices (Schedule VIII 22 languages) | **Missing** | 🔴 |
| Age gate / parental consent | **Missing** | 🔴 |
| DPO designation flag (`isSignificantDataFiduciary`) | **Missing** | 🟡 — only relevant past 2 cr users |
| Privacy policy page at `app/(pages)/privacy/page.tsx` | ✅ exists | content not audited |

## Gap

| # | Gap | Phase | Severity |
|---|-----|-------|----------|
| 1 | Granular consent at consumer signup | Phase 3 (13 May 2027) | 🔴 |
| 2 | DSAR endpoints (5 rights) | Phase 3 | 🔴 |
| 3 | Withdrawal cascade — `withdrawnAt` actually revokes downstream processing | Phase 3 | 🔴 |
| 4 | Retention sweeper — auto-purge past `retainUntil` | Phase 3 | 🔴 |
| 5 | Multilingual notices (Hindi + Bengali + Tamil minimum) | Phase 3 | 🟠 |
| 6 | Age gate + verifiable parental consent | Phase 3 | 🟠 |
| 7 | `checkConsent` actually checks the latest grant | Phase 3 | 🔴 — without this, even granted consent isn't enforced |
| 8 | Public-facing grievance officer (separate from Consumer Protection officer) | Phase 3 | 🟠 |
| 9 | Org-side parity: `ConsentArtifact` per org operator | Phase 3 | 🟡 |
| 10 | DPO designation if Significant Data Fiduciary | Phase 3 | 🟢 (only past threshold) |

## Required

### A. Consumer signup consent (PR 1)

1. **Schema**: `ConsumerConsentArtifact` model — analogous to org-side `ConsentArtifact`. Fields: userId, version, purposeCodes[], grantedAt, withdrawnAt, language, hash (SHA-256 of consent text + timestamp), retainUntil.
2. **Signup form**: granular toggles per purpose:
   - `BOOKING` — required (cannot complete signup without it)
   - `PAYMENT_PROCESSING` — required
   - `SESSION_RECORDING` — optional, asked again per-session
   - `MARKETING_EMAILS` — optional, default off
   - `ANALYTICS_THIRD_PARTY` — optional, default off
3. **Persist on signup** + on every consent change.
4. **Privacy policy** must list each purpose explicitly.

### B. DSAR endpoints (PR 2)

1. `GET /api/me/data-export` — generate a JSON dump of all the user's records across the schema. Returns within 7 days (Phase 3 standard SLA).
2. `POST /api/me/data-correction` — user submits correction request; admin actions it.
3. `DELETE /api/me/account` — initiates erasure; cascade described below.
4. `POST /api/me/grievance` — submits a DPDP grievance to the DPO.
5. `POST /api/me/nominate` — designates a nominee for the user's data post-mortem.

### C. Erasure cascade (PR 3)

When a user requests deletion:

1. Mark `User.erasureRequestedAt`.
2. Run within 30 days (Phase 3 standard).
3. Cascade:
   - Anonymise `User` record (keep ID + hashed email for tax-record integrity; remove name, profile pic, etc.).
   - Delete `ConsumerProfile` / `ConsultantProfile` PII.
   - Anonymise message threads (replace user's messages with `[deleted]`).
   - Recordings: per-recording delete option; default retention rule applies.
   - **Tax records (TDSRecord, Invoice)**: cannot be deleted — retain for 7 years (statutory). User is informed.
4. Email user a confirmation with what was retained and why.

### D. Retention sweeper (PR 4)

`jobs/compliance/dpdp-retention-sweeper.ts` runs weekly:
- For each `ConsumerConsentArtifact` past `retainUntil`: anonymise (keep hash for audit copy).
- For each `ConsentArtifact` (org) past `retainUntil`: same.
- For inactive users (no login in 3 years): apply Phase 3 erasure cascade automatically with prior 60-day notice email.

### E. Multilingual notices (PR 5)

- All consent text + privacy policy + grievance form available in: English, Hindi, Bengali, Tamil at minimum. Telugu / Marathi / Gujarati / Kannada / Malayalam / Punjabi as growth markets.
- Detect language from browser; allow user override.
- The 22-Schedule-VIII full set is aspirational; ship the top 10 by population.

### F. Age gate (PR 6)

- Date-of-birth field at signup. If under 18, parental consent flow:
  - Parent's email + signed consent (digital signature or DSC if available).
  - Block payment / recording features until verified.
  - Flag profile as `MINOR` for the operator's view.

### G. checkConsent enforcement (PR 7)

- Every data-touching code path (booking, payment, recording, analytics) calls `checkConsent(userId, purposeCode)`.
- Returns `false` if the latest grant is missing, expired, or withdrawn.
- Caller short-circuits with a 403 + UX prompt to re-grant.

## Acceptance

- A new consumer cannot complete signup without ticking the required consent boxes.
- Consumer can withdraw any optional consent in <3 clicks from settings.
- `GET /api/me/data-export` returns a JSON dump within 7 days.
- `DELETE /api/me/account` triggers anonymisation in 30 days.
- A breach detected at T fires an alert email at T + 60h (12h before deadline) and again at T + 72h.
- Inactive users (3+ years) get a 60-day notice email then auto-anonymisation.
- Privacy policy + signup form available in 4+ languages.
- Minor users blocked from payment until parental consent is verified.

## Don't build

| Don't build | Reason |
|---|---|
| Custom consent management platform | A Phase-2 Consent Manager framework will be third-party-provided; integrate when available. |
| Aadhaar-based parental verification | Aadhaar UIDAI auth is restricted; use a digital signature or PAN-based verification. |
| Cross-product data sharing without separate consent | Each new purpose requires a fresh consent prompt; don't piggyback. |

## References

- [DPDP Rules 2025 PIB notification](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)
- [MeitY DPDP Rules 2025](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa)
- [Deloitte DPDP Rules implementation guide](https://www.deloitte.com/in/en/services/consulting/about/indias-dpdp-rules-2025-leading-digital-privacy-compliance.html)
- See also: [09](./09-consumer-protection-and-grievance.md) (the OTHER grievance officer, under E-Commerce Rules 2020), [#701](https://github.com/Practitionist/familiarise_web/issues/701) (org-side DPDP epic).
