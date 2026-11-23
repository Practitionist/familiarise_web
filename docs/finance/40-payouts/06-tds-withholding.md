---
title: TDS withholding on payouts
type: reference
audience: engineers changing payout tax code, and finance operators checking a withholding
status: live
last-reviewed: 2026-10-23
---

# TDS withholding on payouts

When the platform pays an expert or a host organisation, it withholds income tax at source (TDS) and sends the rest. This page is the mechanics: which engine decides the amount, what the amount is based on, how the yearly exemption and the catch-up work, what is written down, and how a refund unwinds it. The statutory rules these mechanics encode, the section mapping and the quarterly return are in [TDS rules and returns](../60-tax/03-tds-rules-and-returns.md).

The platform withholds as an e-commerce operator under section 194-O of the Income-tax Act 1961, which is section 393(1) Table Sl. 8(v) of the Income-tax Act 2025 (payment code 1035) for periods from 1 April 2026. Only payees who are Indian residents are paid, so only that regime is implemented. A non-resident payee is refused at disbursement.

## Which engine runs

Two engines exist in the code. The 194-O engine is the default and is the one that runs. The legacy engine runs only when the environment variable `TDS_ENGINE` is set to `LEGACY`.

`planConsultantPayoutTds` (`lib/payments/payouts/consultant-tds.ts`) reads `process.env.TDS_ENGINE ?? "194O"` inside `resolveDueTds`.

- **194-O engine (default).** Withholds on the gross consideration of the payout, with the yearly exemption, the year-to-date base and the one-time catch-up described below.
- **Legacy engine (`TDS_ENGINE=LEGACY`).** Keeps the older rule of a ₹50,000 yearly threshold (`TDS_THRESHOLD_PAISE`, 5,000,000 paise in `lib/payments/tax/tds-service.ts`) applied to the cumulative net share, and taxes only the part above it. The rate still comes from the 194-O rate row, so it is the threshold that differs, not the rate. This engine is a flag-only fallback. The file `tds-service.ts` is still imported by the 194-O engine for its financial-year arithmetic and its record writers, so it is not dead code.
- **Shadow mode.** `ENABLE_TDS_194O_GROSS` defaults to on (`lib/feature-flags.ts`). Set to `false`, the planner withholds on the net share instead and records a `TDS_194O_GROSS_SHADOW_DIFF` system event whenever the gross-based figure would have been different.

The organisation rail has no engine switch. It always uses the computation in [Organisation payouts](05-org-payouts-and-clawbacks.md). Its base, `netPayoutPaise` (the share after the platform fee), is pending CA confirmation, since the consultant rail withholds on the gross.

## The base: gross consideration

Section 194-O taxes the gross amount of the sale, not the platform's commission. The base for a consultant payout is therefore the gross of the earnings in the payout, after proportional refunds, and without GST: `ConsultantEarnings.grossAmount` is `Payment.originalAmount`, the list price before discounts, credits and tax. `earningsGrossPaise` sums it and subtracts the part of the gross that matches any refunded share. For example, Hannah's three ₹5,000 sessions have a gross of 1,500,000 paise although her share after the platform fee is 1,200,000, and 1,500,000 is the base.

## The rate

`computeTdsForPayout` (`lib/compliance/tds.ts`) picks the rate, called through `computeResidentPayoutTds`. The rate row comes from `resolveEffectiveTdsRate`, which reads the latest `TdsRate` row in force for the section (194O or its 2025 equivalent 393-8(v)) and falls back to built-in defaults if the table has no row.

| Situation      | Rate                   | Where it comes from                                          |
| -------------- | ---------------------- | ------------------------------------------------------------ |
| PAN on file    | 10 basis points (0.1%) | `TdsRate` row, `TDS_SECTION_DEFAULT_BPS` as the fallback     |
| No PAN on file | 500 basis points (5%)  | `noPanRateBps` on the row, `NO_PAN_BPS_194O` as the fallback |

A PAN counts as on file for a consultant only when an encrypted PAN is stored and `panVerified` is true (`consultantPanOnFile`). A furnished but unverified PAN is withheld at the no-PAN rate and loses the yearly exemption until an administrator verifies it. For an organisation, an encrypted PAN on file is enough. The no-PAN rate applies before everything else on the resident path. The rates for the other sections (194J at 1,000 basis points, 194C at 200, and 2,000 as their no-PAN rate) exist in the shared constants but apply only when a payee carries an explicit section override, which payouts do not set.

An administrator verifies a PAN at `POST /api/admin/users/[userId]/tax-info/verify-pan` (`payouts.manage`, step-up, reason). It compares the consultant's name with the holder name of their verified payout account and refuses a mismatch unless the administrator overrides it, recording both names.

## The yearly exemption

`resolve194OTaxablePaise` (`lib/compliance/tds-194o.ts`) decides the taxable base. The ₹5,00,000 exemption (`TDS_194O_EXEMPTION_PAISE`, 50,000,000 paise) applies only when all three of these hold.

1. The payee is an individual or an HUF (`taxEntityType` is `INDIVIDUAL` or `HUF`). A company, a firm, an LLP and an unknown entity type are taxed from the first rupee.
2. A PAN is on file (verified, as above).
3. The financial year's gross, including this payout, is at most ₹5,00,000.

If the exemption is not available, the base is this payout's own gross. If it is available and the cumulative gross stays within ₹5,00,000, the base is zero. When the cumulative gross first goes above ₹5,00,000, the base becomes the whole year-to-date gross, not just the excess. The financial year runs April to March in India time (`getIndianFinancialYear`).

## Year-to-date, catch-up and carry

Because the crossing payout is taxed on the whole year-to-date gross, it carries a catch-up for the earlier, exempt payouts. The sequence in `planConsultantPayoutTds` is:

1. **Prior gross.** `priorFyGrossPaise` sums the gross of earnings in the expert's other live payouts (PROCESSING or COMPLETED), and in a re-armed APPROVED payout that kept its staged TDS (`netAmount` set), stamped with this financial year; the same payouts count toward assigned TDS and carry, so a payout planned while a retry waits sees it; an older payout with no financial-year stamp counts by its earnings' `paidAt`.
2. **Required TDS** is 10 basis points of the year-to-date base.
3. **Assigned TDS** is what the expert's other payouts this year have already withheld at the with-PAN rate, plus carry, less credits, with reversals netted. Payouts withheld at the no-PAN rate are left out.
4. **Due** is required minus assigned.
5. **Catch-up** is flagged when TDS is required but nothing has been assigned yet. The database allows one catch-up payout per expert per financial year (`consultant_payout_one_tds_catch_up_per_fy`, a unique index on `tdsCatchUpFy` in `prisma/sql/check-constraints.sql`). If two payouts race for it, the loser's staging write fails and it re-plans with `allowCatchUp` false, withholding the increment the winner left but never more than the tax on its own gross.
6. **Settlement.** `settle194OWithholding` caps what a payout withholds at its capacity, the payout amount less clawback recovery, so the net is never negative. Anything over the capacity is carried to later payouts (`tdsCarryPaise`). The column is a signed change to the running carry: positive when this payout leaves tax for later, negative when it consumes or cancels carry from earlier payouts, so the running carry is the sum over the year's payouts. A negative due, which happens when refunds pull the year's gross back to ₹5,00,000 or less after a catch-up, comes back as a credit (`tdsCreditPaise`) that is paid out in cash.

### Worked examples

All use a 10 basis point rate. Hannah is an individual with a verified PAN.

| Case                                                         | Gross this payout | Year-to-date gross after | Taxable base | TDS    | Share paid | Cash to bank |
| ------------------------------------------------------------ | ----------------- | ------------------------ | ------------ | ------ | ---------- | ------------ |
| Within the exemption, ₹1,20,000 earned before                | 1,500,000         | 13,500,000               | 0            | 0      | 1,200,000  | 1,200,000    |
| Crossing: ₹4,90,000 earned before, a ₹20,000 gross payout    | 2,000,000         | 51,000,000               | 51,000,000   | 51,000 | 1,600,000  | 1,549,000    |
| After the crossing, a ₹10,000 gross payout (assigned 51,000) | 1,000,000         | 52,000,000               | 52,000,000   | 1,000  | 800,000    | 799,000      |
| Same ₹15,000 gross payout, but PAN not verified              | 1,500,000         | not used                 | 1,500,000    | 75,000 | 1,200,000  | 1,125,000    |
| An expert registered as a company, ₹15,000 gross             | 1,500,000         | not used                 | 1,500,000    | 1,500  | 1,200,000  | 1,198,500    |

In the crossing row the base is the whole ₹5,10,000 (51,000,000 paise), so TDS is ₹510 (51,000 paise), not ₹10. The next payout pays only 1,000 paise (₹10), which is 10 basis points of its own ₹10,000 gross, because the year's required TDS of 52,000 is already 51,000 assigned. The cash column is the share less TDS, before any clawback recovery.

## What is written, and when

The plan is computed and staged on the payout row just before the gateway call: `tdsDeducted`, `netAmount`, `tdsRateAppliedBps`, `tdsFinancialYear`, `tdsCatchUpFy`, `tdsCarryPaise` and `tdsCreditPaise`. Staging first means a completion webhook that arrives immediately posts the right cash leg. If the payout fails or never leaves, every staged field is cleared (`tdsDeducted` 0, the rest null or 0).

Nothing is recorded as a deduction until the bank confirms. `completeConsultantPayoutInTx` writes, in the completion transaction:

- the ledger journal `payout:<id>`: `Dr CONSULTANT_PAYABLE`, `Cr CASH` for the cash sent and `Cr TDS_PAYABLE` for the TDS (the TDS line flips to a debit for a credit payout);
- a `TDSRecord` for the quarter that contains the completion instant, with section `194O`, the rate applied in basis points, and the cumulative amount credited. The financial year and quarter come from the completion time, not from the batch time, so a late-March batch that completes in April is filed in the right quarter;
- for a credit, a negative `TDSRecord` and a `TdsAdjustment` that says why.

A `TDSRecord` names exactly one deductee, a consultant or an organisation (`tds_record_deductee_xor`), and cites only its own rail's payout (`tds_record_payout_rail_matches`), both in `prisma/sql/check-constraints.sql`. The organisation rail writes its record at completion through `recordOrgTDSDeduction`.

## Refunds and reversals

When a refund lands after TDS was recorded, `recordTdsReversal` (`lib/payments/tax/tds-service.ts`) writes a negative `isReversal` record with a `TdsAdjustment`, in the same transaction as the refund cascade.

- The amount reversed is the original TDS times the refunded fraction, and never more than the refunded earning's own gross times the rate. A year-to-date catch-up on the same payout therefore stays withheld.
- The total reversed is capped at the original withholding, so an app refund followed by a lost chargeback cannot reverse twice.
- If the original quarter is not yet reported, the reversal is filed in that quarter. If the original has been reported (`reportedInForm26Q` or a challan number), the adjustment is filed in the current quarter, because correcting a filed return is a manual accountant action.
- If the bank returns a completed payout, the whole TDS record is reversed and any credit that was paid is re-owed, so the next payout recomputes it.
- The unique key allows one reversal row per payout and quarter, so a second reversal in the same quarter (two refunds, a refund then a chargeback, or a refund then a bank return) decrements the existing unfiled row with a compare-and-set on its prior amount. Each reversal still writes its own `TdsAdjustment`.

The organisation rail reverses through `recordOrgTdsReversal`: in full on a bank return, and pro rata on a refund, a lost chargeback, a credit-funded cancellation or a completion shortfall, where the reversed fraction is the reversed share over `netPayoutPaise` (`orgClawbackNetOfTds`). The reversed TDS is not yet journaled on either rail: `TDS_PAYABLE` moves only on payout completion and bank return, so after a refund-driven reversal the payable keeps a residual debit equal to the TDS reversed.

## Rules and their enforcers

| Rule                                                                   | Enforcer                                                                   | Test                                                       | Repair                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| The 194-O engine runs unless `TDS_ENGINE=LEGACY`                       | `resolveDueTds` in `consultant-tds.ts`                                     | `__tests__/payments/dispute-payout-block.test.ts`          | Remove the override                                                    |
| The exemption needs an individual or HUF, a PAN and a year at most ₹5L | `resolve194OTaxablePaise` in `lib/compliance/tds-194o.ts`                  | `__tests__/payments/payout-194o-individual-exempt.test.ts` | Verify the PAN, set the entity type                                    |
| Only one catch-up per expert per financial year                        | `consultant_payout_one_tds_catch_up_per_fy`; the loser re-plans            | `__tests__/payments/payout-194o-individual-exempt.test.ts` | None needed; the loser pays on its own gross                           |
| A retry sends the TDS its first attempt staged, catch-up included      | `processSinglePayout` reuses a staged `netAmount`; the claim keeps the TDS | `__tests__/payments/payout-retry-frozen-body.test.ts`      | A retry whose catch-up was taken fails unsent; the next batch re-plans |
| A payout never withholds more than it pays                             | `settle194OWithholding` capacity cap                                       | `__tests__/compliance/audit-1132-regressions.test.ts`      | The excess carries to the next payout                                  |
| A reversal never exceeds the original withholding                      | The cap in `recordTdsReversal`                                             | `__tests__/payments/tds-reversal.test.ts`                  | None needed                                                            |
| A TDS record has one deductee and the right rail's payout              | `tds_record_deductee_xor`, `tds_record_payout_rail_matches`                | none (database constraint)                                 | None needed                                                            |
| A non-resident payee is not paid                                       | `processSinglePayout` refusal and `NON_INDIA` in `payoutEligibilityReason` | `__tests__/enterprise/payout-eligibility-reason.test.ts`   | Pay manually after section 195 is implemented                          |

## Where in code

- `lib/payments/payouts/consultant-tds.ts` — `planConsultantPayoutTds`, `earningsGrossPaise`.
- `lib/compliance/tds-194o.ts` — `resolve194OTaxablePaise`, `settle194OWithholding`.
- `lib/compliance/tds.ts` — `computeTdsForPayout`, `resolveEffectiveTdsRate`, the rate constants.
- `lib/payments/payouts/shared-lifecycle.ts` — `computeResidentPayoutTds`, `buildPayoutCompletionPostings`.
- `lib/payments/tax/tds-service.ts` — financial-year helpers, `recordTDSDeduction`, `recordTdsReversal`, the organisation twins.
- `prisma/seedFiles/15a-create-tds-rates.ts` — the append-only `TdsRate` rows.

## Related

- [TDS rules and returns](../60-tax/03-tds-rules-and-returns.md)
- [Consultant payouts](03-consultant-payouts.md)
- [Organisation payouts and clawbacks](05-org-payouts-and-clawbacks.md)

## Deprecated & Superseded Approaches

- **"Consultant TDS is section 194J at ₹50,000 and 10 percent (20 percent without PAN)."** Several older documents say so. The consultant path withholds under 194-O at 0.1 percent (5 percent without a verified PAN), with the ₹5,00,000 exemption. The ₹50,000 threshold survives only under `TDS_ENGINE=LEGACY`, and even then at the 194-O rate.
- **The header comments of `tds-service.ts` and `tds.ts`** call the former "the production pipeline" and the latter's consolidation "slated". The 194-O engine is the live one; `tds-service.ts` stays because the live engine imports its helpers. Do not delete it as dead code.
- **A flat "net share" base.** Withholding on the net share is the shadow-mode behaviour behind `ENABLE_TDS_194O_GROSS=false`. The live base is the gross.
- **`getUnreportedRecordsForQuarter` and a `reportedInForm26Q` stamp from the draft job.** The draft export deliberately does not stamp records as reported; see [TDS rules and returns](../60-tax/03-tds-rules-and-returns.md).
