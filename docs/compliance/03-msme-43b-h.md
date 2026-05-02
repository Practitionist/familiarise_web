# 03 — MSME Section 43B(h) — 15/45-day payment rule

> **Status:** ✅ derivation live (`computeMsmePaymentDeadline`); ✅ alert cron live + GH Actions schedule wired (Round 2, daily 04:30 UTC); 🟡 counterparty data capture (`isMsme`, `udyamNumber`, `writtenAgreementWithFamiliarise`) needs UX flow.
> **Audience:** payout pipeline + consultant onboarding code.
> **Last reviewed:** 2026-05-02
> **Linked issues:** [#681](https://github.com/Practitionist/familiarise_web/issues/681) (compliance master), [#737 §1.5](https://github.com/Practitionist/familiarise_web/issues/737), [#738](https://github.com/Practitionist/familiarise_web/issues/738) (FF-5 confirmed live).

## What it is

Section 43B(h) of the Income Tax Act (inserted by Finance Act 2023) requires that payments to MSME-registered suppliers be made within:

| MSME size | Without written agreement | With written agreement |
|---|---|---|
| **MICRO** / **SMALL** | 15 days from invoice date | 45 days from invoice date |
| **MEDIUM** / **NONE** | Buyer's default terms (60 days max recommended) | Buyer's default terms |

If the buyer breaches the deadline, **the expense is disallowed in the current year's tax computation** until actually paid. Hard ceiling: 43B(h) days WIN over a longer `defaultTermsDays`.

Udyam registration number format: `UDYAM-XX-NN-NNNNNNN` (19 chars). MSME status comes from a self-declaration + Udyam certificate; Familiarise stores `ConsultantProfile.isMsme` + `msmeRegistrationNumber` + `msmeType` (`MICRO` / `SMALL` / `MEDIUM` / `NONE`) + `writtenAgreementWithFamiliarise` (bool).

## When it applies

### B2B (org-sponsored)

- **Applies.** When an org makes a payout to an MSME-registered consultant, the deadline is 15 / 45 / `defaultTermsDays` from the invoice date. `OrganizationPayout.mustPayByDate` is the derived field.
- The org's books (not ours) carry the disallowance risk, but the platform must surface the deadline so finance/AP doesn't miss it.

### B2C (consumer marketplace)

- **N/A on the consumer leg.** The consumer pays the platform; there's no buyer-supplier relationship between consumer and consultant under 43B(h).
- **N/A on the platform-to-consultant payout leg either** — Familiarise pays from the consumer's payment within days, well inside any 15/45 window. The platform's books bear the disallowance risk, but it is mathematically not breached when payouts run weekly/monthly.

So 43B(h) is effectively a **B2B-only** compliance — but the schema fields (`isMsme`, etc.) sit on `ConsultantProfile` regardless of rail because the same consultant may earn through both rails.

## Current code

| File | What it does | State |
|---|---|---|
| `lib/compliance/msme.ts:54–76` | `computeMsmePaymentDeadline` — MICRO/SMALL 15/45-day, MEDIUM/NONE default | ✅ live |
| `lib/compliance/msme.ts:83` | `isValidUdyamNumber` — regex check | ✅ live |
| `OrganizationPayout.mustPayByDate` (schema) | Stamped at payout creation from `computeMsmePaymentDeadline` | ✅ schema-final |
| `ConsultantProfile.isMsme`, `msmeRegistrationNumber`, `msmeType`, `writtenAgreementWithFamiliarise` | Schema fields | ✅ |
| `jobs/compliance/msme-payment-alerts.ts` | Sweeps payouts within 5 days of `mustPayByDate`; emails finance via Resend | ✅ live |
| `.github/workflows/msme-payment-alerts.yml` | Daily 04:30 UTC | ✅ wired (Round 2) |
| Consultant onboarding form | Captures `isMsme` + Udyam number + written-agreement toggle | 🟡 status unknown — verify on next walkthrough |

## Gap

| Gap | Severity |
|---|---|
| Consultant onboarding flow may not collect `isMsme` / `msmeRegistrationNumber` / `writtenAgreementWithFamiliarise` cleanly | 🟡 |
| No admin UI to verify Udyam registration against the live Udyam portal | 🟡 |
| `mustPayByDate` is stamped at payout creation, but if the org's `defaultTermsDays` changes mid-cycle, in-flight payouts don't update | 🟢 (edge case) |
| No back-office workflow if a 43B(h) breach happens — alert cron fires, then what? | 🟡 — needs runbook |

## Required

1. **Onboarding UX**: ensure the consultant signup / settings flow captures the MSME fields with a clear UDYAM-format hint and a written-agreement checkbox tied to org contract acceptance.
2. **Admin verification**: a small `/dashboard/admin/consultants/[id]/verify-msme` page that lets staff lookup the Udyam number externally + flip a `msmeVerifiedAt` timestamp (schema add).
3. **Runbook**: `docs/runbooks/msme-deadline-approaching.md` documenting what finance does when the alert email fires (chase finance team, accelerate payout, escalate to org admin if blocked).
4. **Optional (defer)**: integrate the [Udyam search API](https://udyamregistration.gov.in/) for live verification; it has no public API today, so manual verification is fine for v1.

## Acceptance

- An MSME-registered consultant with no written agreement and an invoice issued 1 May 2026: `mustPayByDate = 16 May 2026`.
- Same with written agreement: `mustPayByDate = 15 Jun 2026`.
- A non-MSME consultant: `mustPayByDate = invoiceDate + contract.defaultTermsDays` (default 60).
- Daily cron at 04:30 UTC fires email to `MSME_ALERT_EMAIL` whenever any payout has `mustPayByDate < now + 5d` and `status != COMPLETED`.
- Structured log `event: "msme.payout.at_risk"` emitted regardless of email config.

## Don't build

- Internal Udyam-portal scraper. The portal has anti-bot measures and no API. Verify manually.
- Calendar reminders to consultants about their MSME status — that's their CA's job, not ours.

## References

- [MSME 43B(h) explainer (TaxGuru)](https://taxguru.in/income-tax/section-43bh-payments-msme-suppliers.html)
- [Udyam registration portal](https://udyamregistration.gov.in/)
- [CBDT Circular 1/2024 on 43B(h)](https://incometaxindia.gov.in/communications/circular/circular-no-1-2024.pdf)
- See also: [04-tds-quarterly-filings.md](./04-tds-quarterly-filings.md) (Form 26Q includes MSME flags).
