---
title: GST, tax invoices and credit notes
type: reference
audience: engineers changing checkout tax, invoices, credit notes or the GST register, and finance staff reading them
status: live
last-reviewed: 2026-11-02
---

# GST, tax invoices and credit notes

The platform bills as the principal supplier for GST (ADR 26, `docs/enterprise/70-design-decisions/26-gst-principal-model.md`). Every payment is the platform's own outward supply, so every taxable payment needs a document that satisfies CGST Rule 46, every refund needs a credit note under section 34, and the month's documents must reach the GST return as one register. This page is the reference for the rate, the place-of-supply rules, the zero-rating gate, the two document families, their numbering, the credit-note cap and cutoff, the outward-supplies register and the e-invoicing gate. It states only what `lib/compliance/` and `lib/payments/tax/` implement.

There is no GST TCS under section 52. The principal-supplier model means the platform does not collect it, and neither the schema nor the code has any machinery for it.

## The rate and the checkout charge

GST is 18 percent on every domestic taxable supply the platform makes (`TAX_CONSTANTS.GST_RATE`); a zero-rated export is described below. The default SAC code is 999293, commercial training and coaching. A personal tax invoice always carries 999293, and an organisation invoice carries the organisation's default code (`hsnDefault`) or 999293. The checkout tax result also names a code by service type, 999294 for webinars and classes, but that code is not written onto a document.

`deriveCheckoutAmount` (`lib/payments/pricing/derive-checkout-amount.ts`) charges the tax in a fixed order: list price, then discount, then GST on the discounted base through `determineTax` (`lib/payments/tax/tax-engine.ts`), then referral credits against the tax-inclusive total. `determineTax` rounds to the nearest paisa, because GST is a levy and flooring would under-collect.

For example, Priya books Hannah's one-hour consultation for ₹1,000 with no discount. GST is ₹180 (18,000 paise) and she pays ₹1,180 (118,000 paise).

### Which country is the buyer in

`detectBuyerCountry` (`lib/payments/tax/buyer-country.ts`) takes a two-letter country from the buyer's profile first, then a geo-IP header when present, and otherwise assumes India. The browser language is deliberately not a signal, because it would zero-rate sales on a guess. Domestic means GST is charged.

## Zero-rating and the Letter of Undertaking

A sale to a buyer outside India is zero-rated, with no GST, only under a Letter of Undertaking (LUT) valid for the current financial year (CGST Rule 96A). `hasValidPlatformLut` (`lib/compliance/lut.ts`) answers from the platform's LUT number and its valid-till date, and the date is inclusive to the end of that day in India time. The code does not cap that date at the financial-year end, so `PLATFORM_LUT_VALID_TILL` must be set no later than 31 March of the year the LUT was filed for. The contract is fail-closed: with no LUT, or an expired one, nothing is zero-rated and the supply is taxed at 18 percent IGST. Both `determineTax` at checkout and `deriveGstBreakdown` at invoicing consult the same function, so the two cannot drift apart. A zero-rated export invoice quotes the LUT number (`lutNumberForSupply`).

## Place of supply

`deriveGstBreakdown` (`lib/compliance/gst.ts`) decides the tax heads for an organisation invoice. `deriveConsumerInvoiceTax` (`lib/payments/billing/consumer-invoice.ts`) decides them for a personal buyer. Their rules differ for a missing state, on purpose.

| Buyer                          | Buyer state      | Result                                                                                  | Recorded reason or source                     |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| Organisation (registered, B2B) | Same as supplier | CGST 9% and SGST 9%, CGST floored, SGST takes the odd paisa                             | `INTRA_STATE_CGST_SGST`                       |
| Organisation                   | Different state  | IGST 18%                                                                                | `INTER_STATE_IGST`                            |
| Organisation                   | Unknown          | IGST 18%, flagged so a missing state is visible                                         | `IGST_STATE_UNKNOWN`                          |
| Organisation outside India     | n/a              | Zero-rated under a valid LUT                                                            | `ZERO_RATED_EXPORT`                           |
| Organisation outside India     | n/a              | 18% IGST without a valid LUT                                                            | `EXPORT_NO_LUT_IGST`                          |
| Person, state declared         | Same as supplier | CGST and SGST                                                                           | `DECLARED_AT_CHECKOUT` or `PROFILE_ON_RECORD` |
| Person, state declared         | Different state  | IGST for the whole tax                                                                  | `DECLARED_AT_CHECKOUT` or `PROFILE_ON_RECORD` |
| Person, no state on record     | Absent           | Placed at the supplier's own state, so CGST and SGST (section 12(2)(b) of the IGST Act) | `SUPPLIER_DEFAULT_12_2_B`                     |
| Person outside India           | n/a              | Delegated to the same LUT gate, with amounts kept as charged                            | per the gate                                  |

An organisation's buyer country is India only when its data residency region is India (`orgBuyerCountry`). A registered buyer is expected to have a state, so a missing one is a defect worth surfacing, while for a consumer a missing state is the legal norm. Domestic checkout now asks for a valid state: `handleCheckout` refuses a buyer-paid domestic checkout without one, and the pay-links snapshot the profile state or ask for it. Older payments fall back to the profile state and then to the supplier state.

The supplier's own state is the first two digits of the platform GSTIN, which is the state of registration by law (`resolveSupplierStateCode`, `supplierStateCode`). While no GSTIN is set, the registered office's state in `lib/company.ts` (06, Haryana) is the fallback. When the GSTIN's state contradicts the registered office, every GST document refuses: `getPlatformSupplier()` returns null (no consumer mint, 503 on every invoice and credit-note PDF), the register, invoice-healer and IRP runs fail, and `supplierStateCode()` throws (no organisation invoice or rollup). It fails closed because the heads and the printed address would contradict each other on a number that cannot be corrected in place. No environment variable can override the state.

The supplier on every tax invoice, credit note and IRP payload is the legal entity in `lib/company.ts`: Practitionist (OPC) Private Limited, at its registered office in Gurgaon, Haryana. `getPlatformSupplier()` (`lib/pdf/supplier.ts`) pairs that name and address with `PLATFORM_GSTIN`, and the IRP uploader splits the same address into the seller's `Addr1`, `Loc` and `Pin`. The public pages and the footer read the same constants, so the entity a buyer sees on the website is the entity on their invoice.

## Personal tax invoices

`ConsumerInvoice` is the Rule 46 tax invoice for one successful personal payment, unique per payment. `mintConsumerInvoice` runs from `handlePaymentSuccess` once the booking is confirmed (whichever confirmation door reached it), from the recording-purchase and member-overage success handlers, and from the instant-confirm branch of `handleCheckout` (`lib/payments/checkout/orchestrate.ts`) for mock, zero-amount and sponsored checkouts, which never see a webhook. All of them wrap it in `mintConsumerInvoiceBestEffort`, which reports a failure at warning level and never rethrows. A confirmed booking must not roll back because a document could not be made, so a missed mint is healed by `heal-consumer-invoices` (below) and, for the previous month, by the register export.

The mint returns without a document in these cases:

- the payment is not `SUCCEEDED`, or has been soft-deleted;
- the payment is organisation-funded: it has `billableToOrgInvoiceId` or a payment leg sourced from `WALLET`, `LICENSE`, `INVOICE_ACCRUAL` or `OVERAGE_INVOICE_ACCRUAL`. Those supplies never take a second document on the consumer series;
- the payment is not stamped `Payment.gstRegime = REGISTERED`. A payment stamped `UNREGISTERED` was sold with no GST while the platform was not registered, and a payment with no stamp predates the column, when production had no GSTIN, so it counts as unregistered too. Both get a receipt and never a tax invoice, even after a GSTIN is set ([the tax regime](05-gst-registration-and-tax-regime.md)). `CONSUMER_INVOICEABLE_PAYMENT_WHERE` (`gstRegime: "REGISTERED"`) excludes those rows from every healer cohort too;
- the platform GSTIN is unset or malformed. This is a deliberate fail-open for the booking, not an error: a legal-looking invoice with a fabricated GSTIN is worse than none. The process logs it once, and the download routes answer 503 with `SUPPLIER_GSTIN_UNCONFIGURED`. While the GSTIN is unset, `heal-consumer-invoices`, `gst-outward-register-export`, `irp-uploader` and `settle-invoice-accruals` record each run as a config skip (outcome `skipped`, reason `PLATFORM_GSTIN not configured`, HTTP 200, no Sentry event) that the operations console shows. While the GSTIN is unset these skips are expected, so the daily ops digest lists them as a note and `/api/health/jobs` does not page on them; once the GSTIN is set, a config skip pages again. `generate-subscription-invoices` logs the same skip but records a completed run, because its result carries a numeric `skipped` count. A set but malformed GSTIN fails those runs instead. Once the GSTIN is configured, `heal-consumer-invoices` issues the missed invoices for `REGISTERED` payments created in the last 90 days;
- the payment already has a `PENDING` or `SUCCEEDED` refund. The refund's credit note is minted only against an existing invoice, so an invoice minted afterwards would stand with no credit note; ops issue that pair by hand. The check runs inside the mint's transaction before a number is taken, on the capture path and in the healer alike;
- the supplier state is ambiguous (above), or the reconstructed total is zero or less.

The invoice total is the full pre-credit consideration, the amount charged plus any referral credit applied, because a credit the platform funds is a discount, not a reduction of the value supplied. Whether that is the right treatment, and what a credit note must then cover, is an open question for the accountant ([open GST questions](06-open-gst-questions-for-the-accountant.md)). The tax heads are split out of the tax the buyer actually paid, never recomputed from a rate, so the document agrees with the `GST_PAYABLE` credit to the paisa. For an export, that agreement assumes the LUT state has not changed between checkout and the mint: `determineTax` decides the charge from the LUT state at checkout, while `deriveConsumerInvoiceTax` takes the zero-rating classification from the LUT state when the invoice is minted, so an export charged IGST and invoiced after a valid LUT is configured would carry no IGST head and a total below the amount charged. The idempotency probe on `paymentId` runs before any number is allocated, so a redelivered webhook cannot burn a number and leave a gap in a gapless series.

Rule 46 asks a B2C invoice of ₹50,000 (5,000,000 paise) or more to carry the recipient's name, address and state. The mint still issues the invoice without them, because withholding a buyer's document is worse, and sets `needsBuyerAddress` so the register flags it.

## Healing a missed invoice

`heal-consumer-invoices` (`healConsumerInvoices` in `lib/payments/billing/consumer-invoice-healer.ts`) runs from the Netlify ticker every six hours (01:50, 07:50, 13:50 and 19:50 UTC) and mints the invoice for up to 25 payments per run. Its cohort is every `SUCCEEDED`, non-deleted payment created in the last 90 days that has no `ConsumerInvoice`, is not organisation-funded, has a value to invoice, has no pending or succeeded refund, and has not changed in the last 15 minutes, which leaves the capture path's own mint time to land. Each mint is its own short transaction through `mintConsumerInvoice`, which re-checks for a refund inside that transaction (below), so a refund that lands after the cohort read is still declined and the number is allocated only when the invoice is written. A refunded payment is left out because its invoice and credit note must be minted together, and the credit-note mint does nothing without an invoice; ops mint those by hand. The run reads from a random payment id and wraps around, so payments the mint keeps declining cannot starve the rest.

The job holds its lock fail-closed and is a financial job, like the register export. When the capture path mints the same payment at the same moment, one transaction loses the `paymentId` unique and rolls back with its counter increment, so the series keeps no gap and the healer counts the payment as done. While the platform GSTIN is unset the run reads nothing and returns `skipped: "PLATFORM_GSTIN not configured"`, which never reaches Sentry; the GST registration turnover alarm runs in the daily ops digest instead ([the tax regime](05-gst-registration-and-tax-regime.md#4-the-turnover-alarm)). A malformed GSTIN, or one whose state contradicts the registered office, fails the run once instead of once per payment. Failed mints are reported as one Sentry event per run.

**Example.** Priya Anderson pays ₹1,180 (118,000 paise) on Mon 19 Oct 2026 while the platform is registered, and the capture path crashes after commit, before its mint. The 13:50 UTC run that day mints her invoice with `supplyDate` 19 Oct and `issuedAt` the day of the run. Had she paid while `PLATFORM_GSTIN` was unset, she would have paid ₹1,000 with no GST, her payment would be stamped `UNREGISTERED`, and no run would ever invoice it.

## Numbering

| Document                 | Format                    | Example            | Ceiling                          |
| ------------------------ | ------------------------- | ------------------ | -------------------------------- |
| Consumer invoice         | `<PREFIX>-<FY>-<SEQ5>`    | `FAM-2026-00001`   | 99,999 per fiscal year           |
| Consumer credit note     | `<PREFIX>-CN-<FY>-<SEQ4>` | `FAM-CN-2026-0001` | 9,999 per fiscal year            |
| Organisation invoice     | `<PREFIX>-<FY>-<SEQ4>`    | `WIPRO-2026-0001`  | per organisation and fiscal year |
| Organisation credit note | `<PREFIX>-CN-<FY>-<SEQ4>` | `WIP-CN-2026-0001` | per organisation and fiscal year |

The consumer series is platform-wide because the supplier is the platform. The constant `PLATFORM_INVOICE_PREFIX` in `lib/company.ts` sets the prefix to `FAM`; it is not an environment variable, so renaming the series is a code change. Organisation documents take the organisation's `invoiceNumberPrefix` or its slug. `fitPrefixToRule46` (`lib/payments/billing/invoice-numbering.ts`) shortens the prefix so the whole number never exceeds the sixteen characters that Rules 46(b) and 53 allow. The `-CN-` infix costs three more characters, so a credit note's prefix is shorter than its invoice's: the slug `wipro` fits whole in an invoice number and is cut to `WIP` in a credit note. The credit-note series is separate from the invoice series because Rule 53 requires it. The fiscal year in a number is the year in which the financial year starts, reckoned in India time, so a document issued on 31 March 2027 at 23:00 IST is numbered in FY 2026. Each allocation is an atomic upsert on a counter table (`platform_invoice_counters`, `platform_credit_note_counters`, `org_invoice_counters`, `org_credit_note_counters`) that returns the pre-increment value.

## Credit notes

A refund never deletes or rewrites an invoice. A credit note beside it reverses part or all of it. A personal credit note for a refund that returns cash is sized on the cash refunded, and a restored referral credit gets no document. The exception is a booking paid entirely with credits, whose refund takes a credit note sized on the credits; the accountant has not yet ruled on that ([open GST questions](06-open-gst-questions-for-the-accountant.md)).

**Personal.** `mintConsumerCreditNote` runs from the refund cascade (`applyRefundCascade` in `lib/payments/operations/refund.ts`), from the credit-only refund path in `lib/payments/operations/booking-refund.ts`, and from the lost-chargeback settlement in `app/api/webhooks/utils.ts`. It is idempotent on `refundId` or `disputeId`, each unique. `deriveConsumerCreditNoteAmounts` sizes it:

- The reversal is proportional over the tax-inclusive total and keeps the head the invoice used, because a note may not move a supply from one head to another.
- The cap is cumulative. A partial refund and a later lost chargeback are two different keys against one invoice, so the function sums the totals of all earlier notes, locks the invoice row, and credits at most the remainder. An invoice already credited in full refuses the note, records a `SystemEvent`, and returns no id.
- The tax is prorated once from the invoice's total tax and then re-split by the floor-CGST rule, so `taxable + CGST + SGST + IGST = total` holds by construction and no head on a note exceeds the invoice's.

For example, Priya cancels Hannah's session and 50 percent, ₹590 (59,000 paise), is refunded. The note is for 59,000: tax is 18,000 × 59,000 ÷ 118,000 = 9,000 paise and the taxable value is 50,000. If Priya's invoice was CGST and SGST, the note shows 4,500 and 4,500, otherwise IGST 9,000.

**Organisation.** `mintRefundCreditNote` credits only the invoiced part of an organisation-funded payment (the `INVOICE_ACCRUAL` and `OVERAGE_INVOICE_ACCRUAL` legs), and only against an issued invoice (a DRAFT accrual is netted on its leg instead). It caps itself at what the invoice has left (`remainingOrgInvoiceCreditPaise`, the same cumulative cap under a row lock) and restores any purchase-order draw. It does not change the invoice's status: the gateway refund of an invoice payment (`app/api/webhooks/utils.ts`) moves the invoice to `REFUNDED` once the cumulative credit notes cover its total.

### The section 34(2) cutoff

A credit note can reduce output tax only if it is declared by the earlier of 30 November following the end of the financial year of the supply and the date the annual return is filed. The code implements only the 30 November date, because it does not track the annual-return filing date. After that a refund gets a commercial credit note: base value only, no tax. `gstCreditNoteCutoff` (`lib/compliance/gst-credit-note-cutoff.ts`) returns the last instant, the end of 30 November in India time. A supply on 2026-10-17 is in FY 2026-27, so its cutoff is 23:59:59.999 IST on 2027-11-30. A refund of ₹590 after that issues a note for the base ₹500 only, its reason prefixed "Commercial credit note (past the CGST s.34(2) time limit)", and the refund journal reverses no `GST_PAYABLE`, so the platform bears the tax.

The refund cascade pins one clock (`cascadeNow`) across the credit-note mint and the ledger's GST reversal, so a refund processed across midnight on 30 November cannot be classified before the cutoff by one step and after it by another. The date the cutoff runs from depends on the path: a booking refund uses the linked organisation invoice's issue date or else the payment's creation, the organisation credit note uses the invoice's issue date, and a cycle invoice's credit note uses its `billingCycleStart` (falling back to the issue date), because the cycle start is its earliest supply.

## The outward-supplies register

`gst-outward-register-export` (`jobs/compliance/gst-outward-register-export.ts`) runs from the Netlify ticker in hourly slices on the 2nd of each month (04:00 to 23:00 UTC), for the previous India calendar month by default, ahead of the 11th-of-the-month GSTR-1 deadline. Every slice repeats the whole export, so a later slice only refreshes the file. It does four things in order.

1. **Heals.** Up to 25 `SUCCEEDED` payments in the period with no consumer invoice are minted, oldest first. Organisation-funded and zero-value payments are filtered out of the candidates so they cannot fill a slice. A non-zero count is warned about, because it means the checkout mint missed something.
2. **Reads** every consumer invoice, issued organisation invoice, consumer credit note and issued organisation credit note in the period, except commercial credit notes (they reverse no tax, so they are not GSTR-1 documents; their count is warned about), and shapes them into one register through the pure builder in `lib/compliance/gst-outward-register.ts`.
3. **Uploads** the CSV to the private `org-invoices` bucket at `compliance/gst/<first day>_<last day>.csv`, overwriting the previous slice's file.
4. **Stamps** `gstr1ExportedAt` on everything reported, only after the upload succeeded and guarded on the stamp being null, so a re-run never moves anyone's first-reported time.

The CSV header is fixed because the accountant's import template depends on it: `doc_type,doc_number,doc_date,buyer_type,buyer_gstin,place_of_supply,taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise,sac_code,original_invoice_number,payment_id,supply_date`. The file carries no PAN, bank detail or buyer address. The builder warns about any document with no place of supply, any document whose heads do not reconcile to total minus taxable value, and any B2C document of ₹50,000 or more without a recipient address and state.

The job holds its cron lock fail-closed and is in `FINANCIAL_JOB_NAMES`, because its healer allocates numbers from a gapless series. Two concurrent runs would each see a payment as un-invoiced and take a number, and one would lose the unique constraint, leaving a gap that cannot be filled. Not producing the register is recoverable; a gap is not.

The register needs the platform's supplier identity, because without it no consumer invoice can be minted and the file would understate B2C supplies. `platformSupplierForJob()` (`lib/pdf/supplier.ts`) decides before the lock is taken: while `PLATFORM_GSTIN` is unset the run returns `skipped: "PLATFORM_GSTIN not configured"` and answers 200, which the run row stores as a config skip with no Sentry event; a set but malformed or other-state GSTIN throws, so the run fails and reports.

An administrator fetches a month through `GET /api/admin/compliance/gst-register?period=2026-10`. The route is ADMIN-only, rebuilds the storage path with `gstOutwardRegisterCsvStoragePath`, answers 404 for a month the job has not produced, and otherwise redirects to a signed URL that expires after ten minutes. To rebuild another month, call `/api/cleanup/gst-outward-register-export?period=YYYY-MM` with the cron bearer secret; the month is reckoned in India time, and a malformed value answers 400 `INVALID_PERIOD`. Because every run covers exactly one calendar month, the admin route can fetch any file the job has written.

## Document dates are India dates

A tax invoice and a credit note are dated in the supplier's calendar, which is India's. Every date a document carries is the India calendar date of its stored instant, printed by `formatInvoiceDate` (`lib/time/invoice-date.ts`) as "20 Oct 2026": the invoice date, the date of supply, the due date and billing period of an organisation invoice, a credit note's date and its original invoice's date. The four PDFs, the organisation Billing tab (the invoice list, the invoice drawer and the Licence tab), the invoice CSV export (`issue_date_ist`, `due_date_ist`), the invoice-issued and overdue emails and the invoice-issued bell all print through it, labelled "(IST)", so no reader takes the date for their own zone; the back office prints the same text through `formatOperatorInstant`. A payment, a wallet entry or a usage posting is a moment, not a document date, and stays in the viewer's profile zone.

**Example.** An organisation invoice issued at 23:33 UTC on 19 Oct 2026 (05:03 IST on 20 Oct) and due 30 days later reads "Issued: 20 Oct 2026" and "Due: 19 Nov 2026" under "Dates (IST)" on its PDF, rendered on a UTC server, and "Issued (IST) 20 Oct 2026" on the Billing tab for an owner whose profile zone is Los Angeles, where it is still 19 Oct. The decision is [ADR 2026-11-20](../../decisions/2026-11-20-invoice-dates-in-india-time.md).

The e-invoice follows the same rule. `formatDocDate` (`lib/compliance/irp-payload.ts`) files `DocDtls.Dt` and a credit note's `OrigDocDtls.Dt` as the same India date in the IRP's DD/MM/YYYY format (`invoiceDateIso`), so the invoice above is filed as 20/10/2026. ClearTax answers with `AckDt`, an India wall time such as "2026-10-20 21:15:00"; `generateIrn` (`lib/compliance/irp.ts`) reads it as Asia/Kolkata (`fromOperatorWallTime`) and stores the true instant, 15:45 UTC, which the PDF prints as "Ack date (IST)" 20 Oct 2026.

## Downloading a document

| Route                                                          | Returns                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/payments/[paymentId]/invoice/pdf`                    | A 302 to a 24-hour signed URL for the tax invoice                  |
| `GET /api/payments/[paymentId]/credit-note/[creditNoteId]/pdf` | The same, for a credit note that belongs to that payment's invoice |

Both routes authorise the payment's own buyer or an operator, apply the `moneyOpsLimiter` per actor, answer 503 `SUPPLIER_GSTIN_UNCONFIGURED` when the GSTIN is missing and 404 `INVOICE_NOT_ISSUED` when no document exists. The PDF renders on the first request from the snapshot stored on the row, not from live records, because a tax invoice must keep saying what it said on the day it was issued. It is cached in the private bucket for 24 hours.

## E-invoicing for organisation invoices

A B2B `OrganizationInvoice` with a buyer GSTIN is eligible for an Invoice Reference Number. The `irp-uploader` job (`jobs/compliance/irp-uploader.ts`) runs in the ticker's daily window from 03:00 UTC with ten invoices per slice and sends PENDING invoices issued within the last 30 days through ClearTax. It runs only when `PLATFORM_GSTIN` (which it sends to ClearTax as the supplier GSTIN), `CLEARTAX_API_KEY` and `CLEARTAX_GSP_TOKEN` are all present; otherwise it touches no invoice and records a config skip. A set but malformed or other-state `PLATFORM_GSTIN` fails the run instead. There is no separate enable flag. Personal invoices are outside e-invoicing. An IRN can be cancelled only within 24 hours, so the job holds its lock fail-closed and is a financial job.

## Rules and their enforcers

| Rule                                                      | Enforcer                                                                    | Test                                                                   | Repair                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| An export is zero-rated only under a valid LUT            | `hasValidPlatformLut`, consulted by `determineTax` and `deriveGstBreakdown` | `__tests__/compliance/lut-gate.test.ts`                                | Configure a current LUT                                       |
| No tax invoice carries a fabricated GSTIN                 | `getPlatformSupplier` returns null for an unset or malformed GSTIN          | `__tests__/pdf/platform-supplier.test.ts`                              | Set the GSTIN; `heal-consumer-invoices` catches up            |
| An unset GSTIN skips the GST jobs; a bad one fails them   | `platformSupplierForJob`                                                    | `__tests__/compliance/gst-register-requires-platform-supplier.test.ts` | Set `PLATFORM_GSTIN` after registration, or fix the bad value |
| A document number never exceeds sixteen characters        | `fitPrefixToRule46`                                                         | `__tests__/enterprise/gst-doc-number-length.test.ts`                   | Shorten the prefix                                            |
| A webhook redelivery never burns a number                 | The probe on `paymentId` before allocation in `mintConsumerInvoice`         | `__tests__/payments/currency-and-tax-gates.test.ts`                    | None needed                                                   |
| A missed consumer invoice is healed                       | `heal-consumer-invoices` (`healConsumerInvoices`)                           | `__tests__/payments/consumer-invoice-healer.test.ts`                   | Set the GSTIN, or mint a payment older than 90 days by hand   |
| Credit notes never exceed their invoice                   | Cumulative cap under a row lock in `mintConsumerCreditNote`                 | `__tests__/payments/currency-and-tax-gates.test.ts`                    | An operator reviews the recorded `SystemEvent`                |
| Past the section 34(2) cutoff a note carries no tax       | `isPastGstCreditNoteCutoff`                                                 | `__tests__/compliance/gst-credit-note-cutoff.test.ts`                  | None needed                                                   |
| A register row is stamped only after the upload succeeded | The order of upload then stamp in the export job                            | `__tests__/compliance/gst-register-upload-then-stamp.test.ts`          | Re-run the job; the file is overwritten                       |
| A document's date is its India date on every surface      | `formatInvoiceDate` (`lib/time/invoice-date.ts`)                            | `__tests__/enterprise/invoice-dates-india-time.test.tsx`               | None needed; a cached PDF re-renders after 24 hours           |

## Where in code

- `lib/compliance/gst.ts`, `lut.ts`, `gst-credit-note-cutoff.ts`, `gst-outward-register.ts`, `irp.ts`, `irp-payload.ts`.
- `lib/payments/tax/tax-engine.ts`, `buyer-country.ts`.
- `lib/payments/billing/consumer-invoice.ts`, `invoice-numbering.ts`, `credit-note-numbering.ts`, `create-org-invoice.ts`.
- `lib/payments/operations/refund.ts` — `applyRefundCascade`, `mintRefundCreditNote`.
- `jobs/compliance/gst-outward-register-export.ts`, `jobs/compliance/irp-uploader.ts`.

## Related

- [Tax in plain language](01-tax-explainer.md)
- [Open GST questions for the accountant](06-open-gst-questions-for-the-accountant.md)
- [Refunds](../30-refunds-disputes/01-refunds.md)
- [Invoices, purchase orders and dunning](../50-b2b/04-invoices-purchase-orders-and-dunning.md)
- [MSME, statutory exports and the calendar](04-msme-statutory-exports-and-calendar.md)

## Deprecated & Superseded Approaches

- **A GST TCS machinery** (`GstTcsBatch`, a GSTR-8 builder, a TCS walkthrough). It was deleted and does not exist. Several compliance notes still describe it.
- **"International buyers are always 0 percent."** Zero-rating needs a valid LUT; without one the sale is 18 percent IGST.
- **Workflow files and a flag for e-invoicing** (`irp-uploader.yml`, `ENABLE_IRP_UPLOADER`). Neither exists. The job runs on the ticker and is gated by the GSTIN and ClearTax settings.
- **Zero-rating on browser language.** Detecting the buyer's country from `Accept-Language` zero-rated every `en-US` browser. It was removed.
- **Independent clock reads** across credit-note minting and the ledger's GST reversal. They are one pinned `cascadeNow` now.
- **Database writes through the global client** inside the mint error handlers. They pass the enclosing transaction (`db: tx`) so a single-connection pool cannot deadlock.
- **Document dates in UTC or the server's zone.** The consumer documents and the organisation credit note pinned UTC and the organisation invoice used the server's zone, so a document issued before 05:30 IST printed the previous day. The IRP payload filed the UTC date and the acknowledgement was parsed in the server's zone. All of them use India dates now.
- **Environment overrides for the register window and the series.** `GST_REGISTER_PERIOD_START`, `GST_REGISTER_PERIOD_END`, `PLATFORM_INVOICE_PREFIX` and `CLEARTAX_GSTIN` no longer exist. The month is the `?period=YYYY-MM` argument, the prefix is a constant in `lib/company.ts`, and the IRP uses `PLATFORM_GSTIN`.
