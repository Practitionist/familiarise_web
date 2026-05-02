# 01 — TDS overview (sections, rates, thresholds)

> **Status:** 🔴 production bug on B2C side (wrong section + rate). B2B side is closer to correct but still needs wiring.
> **Audience:** anyone working on payouts (`lib/payments/payouts/`), tax helpers (`lib/payments/tax/`, `lib/compliance/`).
> **Last reviewed:** 2026-05-02
> **Linked issues:** [#737](https://github.com/Practitionist/games/familiarise_web/issues/737), [#738](https://github.com/Practitionist/familiarise_web/issues/738) (Item F).

## What it is

Tax Deducted at Source — the income-tax withholding that a payer (us) takes off a payee's (consultant's) income at the moment of payment, and deposits with the government. The right **section** depends on the relationship:

| Section | Applies to | Rate (FY 2025-26) | Threshold | No-PAN fallback |
|---|---|---|---|---|
| **194O** | E-commerce operator pays e-commerce participant | **0.10%** (cut from 1% w.e.f. 1 Oct 2024 by Finance (No. 2) Act 2024) | ₹5,00,000 / FY for resident *individuals/HUF* with valid PAN/Aadhaar; **no threshold** for partnerships / companies / LLPs / non-residents | **5%** (special 206AA carve-out for 194O — not the usual 20%) |
| **194J** | Professional / technical services billed directly | 10% | ₹50,000 / FY | 20% |
| **194C** | Contract works / vendor services | 1% (individual/HUF) or 2% (others) | ₹30,000 single / ₹1,00,000 aggregate | 20% |
| **195** | Any payment to a non-resident | 20% (or DTAA rate if Form 10F + TRC + lower-rate cert produced) | None | DTAA cap or 20% |

**Removed and gone (do not implement):**
- Section 206C(1H) — TCS on sale of goods > ₹50L. Omitted by Finance Act 2025 w.e.f. 1 Apr 2025.
- Section 206AB / 206CCA — higher TDS / TCS for non-filers. Omitted w.e.f. 1 Apr 2025.

## When it applies

### B2C (consumer marketplace)

- A consumer pays the platform via card. Platform is the **e-commerce operator** under Sec 194O Explanation(a). Consultant is the **e-commerce participant** under Explanation(b).
- The right section is **194O at 0.10%**. Threshold of ₹5L applies only to *resident individuals/HUF* with valid PAN/Aadhaar. For everyone else, withhold from rupee 1.
- For non-resident consultants, **194O does not apply** — pivot to **Sec 195 + DTAA**.

### B2B (org-sponsored)

- Org pays via INVOICE / WALLET / LICENSE → no ECO transaction. The org makes a separate **payout to the consultant** via the org payout pipeline.
- For org → consultant payout, classification is **fact-specific**: if the consultant is engaged via the platform (most common), 194O still applies because the platform is the ECO. If the org engages the consultant directly off-platform with their own contract, **194J** would apply — but that's outside our payout flow.
- Default in code: **194O**. Override on `ConsultantProfile.tdsSection` for the rare direct-engagement case.

### Cross-border

- Non-resident consultant on either rail → **Sec 195**. See [doc 07](./07-cross-border-flows.md) for DTAA, Form 10F, TRC, Form 15CA/CB, FIRC.
- Non-resident consumer paying a resident consultant → still 194O on the resident consultant.

## Current code

Two TDS files, two contracts, partial overlap:

| File | Section | Rate | Threshold | No-PAN | Notes |
|---|---|---|---|---|---|
| `lib/payments/tax/tds-service.ts` (B2C path) | 194J ❌ | 10% ❌ | ₹50,000 ❌ | 20% ❌ | **All four wrong** for the e-commerce path. Header explicitly says "Section 194J". |
| `lib/compliance/tds.ts` (B2B / org path) | 194O default ✅ | 1% ❌ | none for orgs ✅ | 20% ❌ | Stale rate (cut to 0.10% in Oct 2024 was missed). 5% no-PAN special carve-out missing. |

Live code in `lib/payments/tax/tds-service.ts:155` even includes a comment "Non-resident guard: Section 194J does not apply to non-residents" — and *skips* the deduction. That's wrong: should pivot to Sec 195 + DTAA, not skip.

## Gap

| Gap | Where | Severity |
|---|---|---|
| Wrong section on B2C path (194J → must be 194O) | `lib/payments/tax/tds-service.ts` | 🔴 |
| Wrong rate on both files (10% / 1% → must be 0.10%) | both | 🔴 |
| Wrong threshold on B2C path (₹50K → must be ₹5L for resident individuals/HUF *only*) | `tds-service.ts` | 🔴 |
| No threshold differentiation by entity type (partnerships / companies / LLPs get no threshold) | both | 🔴 |
| Wrong no-PAN fallback (20% → must be 5% for 194O) | both | 🔴 |
| Non-resident path missing on B2C (currently *skips* deduction) | `tds-service.ts:155` | 🔴 |
| No DTAA / Form 10F / TRC integration on B2C path (B2B has DTAA table) | `tds-service.ts` | 🟠 |
| `ConsultantProfile.taxEntityType` field doesn't exist | `prisma/schema.prisma` | 🟠 |

## Required

In commit order:

1. **`prisma/schema.prisma`** — add `ConsultantProfile.taxEntityType` enum (`INDIVIDUAL` / `HUF` / `PARTNERSHIP` / `COMPANY` / `LLP` / `NON_RESIDENT`). Default `INDIVIDUAL`. Migrate via Supabase MCP.
2. **`lib/compliance/tds.ts`** — fix the rate constant: `"194O": 0.001` (not `0.01`). Add 5% no-PAN constant. Update the no-PAN derivation to apply 5% for 194O / 20% for 194J/194C.
3. **`lib/payments/tax/tds-service.ts`** — pivot the entire file to use `lib/compliance/tds.ts:computeTdsForPayout` (or merge the two). Threshold becomes `taxEntityType === "INDIVIDUAL" || "HUF"` ? `₹5,00,000` : `0`. Non-resident path delegates to Sec 195 (see doc 07).
4. **Migration of historical `TDSRecord` rows**: decide whether to back-correct (refund excess withholding to consultants) or grandfather. Grandfathering is simpler but requires a public communication.
5. **Tests**: per-section, per-entity-type, per-PAN-state, boundary cases at the threshold.

## Acceptance

- A B2C resident-individual consultant earning ₹4L this FY: zero TDS withheld.
- The same consultant earning ₹6L: 0.10% on the marginal ₹1L only (not the full ₹6L).
- A resident **company** consultant earning ₹1: 0.10% withheld immediately.
- A consultant with no PAN: 5% withheld (not 20%).
- A non-resident consultant: pivots to Sec 195 + DTAA via `lib/compliance/tds.ts`, not the B2C 194J file.
- Both `tds-service.ts` and `compliance/tds.ts` use the same rate constants.
- 875+/875+ unit tests pass; new tests cover every threshold/entity/PAN cell.

## References

- [Section 194O (TDSMan)](https://blog.tdsman.com/2025/09/section-194o-tds-on-payments-by-e-commerce-operators-to-participants/)
- [TDS Rate Chart FY 2025-26 (ClearTax)](https://cleartax.in/s/tds-rate-chart)
- [TDS/TCS Changes from 1 Apr 2025 (ClearTax)](https://cleartax.in/s/tds-and-tcs-changes-from-april-2025)
- See also: [02-gst-overview.md](./02-gst-overview.md) (GST TCS Sec 52 is the GST analogue), [04-tds-quarterly-filings.md](./04-tds-quarterly-filings.md) (Form 26Q / 27Q), [07-cross-border-flows.md](./07-cross-border-flows.md) (Sec 195).
