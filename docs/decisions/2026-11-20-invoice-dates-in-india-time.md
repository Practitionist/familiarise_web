# ADR: Invoice dates read in India time everywhere

- **Status**: Accepted by the owner on 2026-11-20. Ships in the pull request that adds this record.
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [GST, tax invoices and credit notes](../finance/60-tax/02-gst-invoices-and-credit-notes.md#document-dates-are-india-dates), [Invoices, purchase orders and dunning](../finance/50-b2b/04-invoices-purchase-orders-and-dunning.md), [The back-office record, D16](2026-11-16-train-6-back-office.md)

## Context

An invoice stores its issue and due dates as instants (`OrganizationInvoice.issuedAt`, `dueDate`, `ConsumerInvoice.issuedAt`, `supplyDate`, the credit notes' `issuedAt`). Each surface turned the instant into a day in a different zone. The organisation invoice PDF used the server's zone, which is UTC on Netlify. The consumer invoice and both credit-note PDFs pinned UTC. The organisation Billing tab used the viewer's profile zone. The invoice emails and the invoice-issued bell used the recipient's zone, and the CSV export wrote raw UTC timestamps.

So one invoice issued in the early hours of an Indian morning printed one day on its PDF and the next day on screen for a viewer in India, and the previous day for a viewer in the Americas. An Indian GST invoice is dated in the supplier's calendar, which is India's: the outward-supplies register, the fiscal year in every number and the credit-note cutoff were already reckoned in IST.

## Worked example

Wipro Limited's invoice `WIPRO-2026-0001` is issued at 23:33 UTC on Mon 19 Oct 2026, which is 05:03 IST on Tue 20 Oct. It is due 30 days later, at 23:33 UTC on Wed 18 Nov (Thu 19 Nov in India). Its owner's profile zone is America/Los_Angeles, where the issue moment is 16:33 on 19 Oct.

| Surface                           | Before                                                                     | Now                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Organisation invoice PDF          | Dates · Issued: 19 Oct 2026 · Due: 18 Nov 2026                             | Dates (IST) · Issued: 20 Oct 2026 · Due: 19 Nov 2026                                   |
| Organisation credit note PDF      | Date: 19/10/2026 · Invoice date 19/10/2026                                 | Date (IST): 20 Oct 2026 · Invoice date (IST) 20 Oct 2026                               |
| Consumer invoice PDF              | Invoice date 19 Oct 2026 · Date of supply 19 Oct 2026                      | Invoice date (IST) 20 Oct 2026 · Date of supply (IST) 20 Oct 2026                      |
| Consumer credit note PDF          | Credit note date 19 Oct 2026 · Invoice date 19 Oct 2026                    | Credit note date (IST) 20 Oct 2026 · Invoice date (IST) 20 Oct 2026                    |
| Billing › Invoices list           | Due 18 Nov 2026, no issue date                                             | Issued (IST) 20 Oct 2026 · Due (IST) 19 Nov 2026                                       |
| Invoice drawer                    | Issued 19 Oct 2026 · Due 18 Nov 2026 · credit note dated 19 Oct 2026       | Issued (IST) 20 Oct 2026 · Due (IST) 19 Nov 2026 · credit note dated 20 Oct 2026 (IST) |
| Invoice CSV export                | `issued_at` 2026-10-19T23:33:00.000Z · `due_date` 2026-11-18T23:33:00.000Z | `issue_date_ist` 20 Oct 2026 · `due_date_ist` 19 Nov 2026                              |
| Invoice-issued and overdue emails | due on 18 Nov 2026                                                         | due on 19 Nov 2026 (IST)                                                               |
| Invoice-issued bell               | due on Wed, 18 Nov 2026 · 3:33 PM PST                                      | due on 19 Nov 2026 (IST)                                                               |

A viewer whose profile zone is India read 20 Oct on screen before this change and 19 Oct on the PDF; both now read 20 Oct.

## Decisions

1. **An invoice date is the India calendar date of its instant.** `formatInvoiceDate` (`lib/time/invoice-date.ts`) prints it ("20 Oct 2026") through `formatOperatorInstant(at, "date")`, the formatter the back office already uses, so the zone (Asia/Kolkata) and the locale are pinned and a server render and the browser print the same text. Invoice dates are the issue date, the due date, the billing period, the date of supply, a credit note's date and its original invoice's date.
2. **Every surface uses that one helper.** The four PDFs (organisation invoice and credit note, consumer invoice and credit note), the Billing › Invoices list, the invoice drawer, the Licence tab's current cycle and next renewal (the cycle becomes the renewal invoice's billing period), the invoice CSV export, the invoice-issued and overdue emails and the invoice-issued bell. The back office already printed every date in IST through the same formatter and is unchanged.
3. **The zone is labelled where a reader might assume their own.** A field or column heading carries "(IST)" (`invoiceDateLabel`), the PDF's date block reads "Dates (IST)", and prose (emails, the bell, a credit-note row) reads "19 Nov 2026 (IST)" (`formatInvoiceDateWithZone`). The CSV columns are `issue_date_ist` and `due_date_ist`.
4. **Moments stay in the viewer's zone.** A payment, a wallet ledger entry and a usage posting are moments, not invoice dates: the drawer's Paid row, the wallet table, the usage Activity column and the invoice-paid bell keep the viewer's profile zone (`ZonedDay`, `useZonedFormat`). The CSV's `paid_at` stays a UTC timestamp. The organisation invoice PDF prints its Paid line in IST with its other dates, because a document has one zone.
5. **Display only.** Nothing billed, stored, numbered or computed changes: the stored instants, the due-date arithmetic (`issuedAt + paymentTermsDays`), the numbering and the outward-supplies register are untouched.

## Consequences

- A stored organisation invoice PDF is re-rendered after its 24-hour cache, and a consumer PDF the same way, so a document rendered before the deploy keeps its old dates for up to a day.
- A program that read the CSV's `issued_at` and `due_date` columns must read `issue_date_ist` and `due_date_ist` instead, now dates rather than timestamps.
- The e-invoice payload sent to the IRP still writes `DocDtls.Dt` from the UTC date (`formatDocDate` in `lib/compliance/irp-payload.ts`). That is a filing value, not a display, so this decision does not change it; for an invoice issued between 00:00 and 05:30 IST it names the previous day. Aligning it needs its own owner decision. E-invoicing runs only once the GSTIN and the ClearTax keys are set.
- The IRN acknowledgement date on the organisation invoice PDF is printed back in the host zone (`irpAckDay` in `lib/pdf/invoice-renderer.tsx`), not through `formatInvoiceDate`. ClearTax returns `AckDt` as an IST wall time ("2026-10-20 05:03:00") and `generateIrn` (`lib/compliance/irp.ts`) parses it in the host zone, so the stored instant is the wall time read as UTC on Netlify; the host zone prints the IRP's own date, and India time would move an evening acknowledgement to the next day. Parsing it as IST would change a stored value and is left to its own decision.

## Deprecated & Superseded Approaches

- **Server-zone and UTC document dates.** `formatDateLong` (server zone) on the organisation invoice, `fmt` (UTC) on the organisation credit note and `formatStatutoryDate` (UTC) on the consumer documents were deleted; `formatInvoiceDate` replaces all three.
- **Invoice dates in the viewer's profile zone.** `ZonedDay` printed the Billing list, drawer and Licence tab dates in the profile zone; it now prints moments only.
