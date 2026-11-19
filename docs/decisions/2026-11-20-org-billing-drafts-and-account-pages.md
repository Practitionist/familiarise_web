# ADR: Draft invoices are for billing managers; session IPs and the voided seed booking stay

- **Status**: Accepted (owner decisions, 2026-11-20), shipped in PR #2903 "fix(org-pages): consent only for active organisations, Billing reads one fact, read-only roles told who can act, plain purchase-order copy".
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [Organisation dashboard pages](../enterprise/30-programs-and-lifecycle/04-dashboard-pages.md), [Roles and permissions](../enterprise/00-foundations/04-roles-and-permissions.md), [API reference](../enterprise/50-operations/01-api-reference.md), [User session visibility and revocation](../enterprise/70-design-decisions/34-user-session-visibility-and-revocation.md)

## Context

A QA round on the organisation pages read three things that needed a product answer rather than a code fix.

- **A draft invoice on a read-only Billing page.** Wipro's MANAGER saw WIPRO-2026-0001, a ₹1,18,000.00 invoice in `DRAFT`, in the invoice list. A draft is not issued, carries no legal number on a PDF and is not owed, so the row told a reader who cannot act on it nothing they could use.
- **IP addresses in the Account sessions list.** The Sessions section prints "Signed in from <IP>" beside each device.
- **A booking billed on a void invoice.** Wipro's ₹2,487.94 session booking (payment `03171f2f-…`) was rolled into WIPRO-2026-0004, which is now `VOID`, so the charge sits in the usage ledger with no live invoice behind it.

## Decisions

1. **D1: only a role that manages billing sees draft invoices.** Who that is comes from the permission matrix: the roles holding `billing.manage`, which today are OWNER and BILLING_ADMIN. Every other finance reader (MAINTAINER and MANAGER today) sees issued, overdue, paid, void and cancelled invoices only.
   - The rule is enforced on the server by one filter, `visibleInvoiceWhere(role)` in `lib/enterprise/invoice-visibility.ts`. The invoice list, the CSV export, the invoice detail and the invoice PDF all read through it. A `?status=DRAFT` list request from a reader returns nothing, and opening a draft by id answers 404 on both the detail and the PDF route. A billing manager still gets the PDF route's 409 `INVOICE_NOT_ISSUED` for a draft, because a draft has no legal PDF.
   - The usage panel (`getOrgReceivables`, `lib/data/org-receivables.ts`) takes the viewer's role. A booking charge billed on a draft shows "WIPRO-2026-0001 · Draft" to a billing manager and "On an invoice not yet issued" to anyone else, with the draft's id and number removed from the page payload.
   - Totals and tiles do not change. "Outstanding" counts only `ISSUED` and `OVERDUE` invoices and "Pending charges" counts payments on no invoice, so neither ever included a draft.
   - Worked example: Wipro's MANAGER opens Billing and sees WIPRO-2026-0005 (Paid), -0006 (Due), -0004 and -0007 (Void). Their CSV export has the same four rows. Requesting `/billing-account/invoices/<WIPRO-2026-0001 id>` answers 404. The OWNER sees all five invoices.
   - Options not chosen: hiding drafts only in the interface (the API and the CSV export would still hand them out); hiding drafts from every role (the billing managers are the people who cancel a draft or ask for it to be issued).
2. **D2: the Account sessions list keeps showing IP addresses.** It is the account holder's own sign-in history, and the IP is how a person tells an unfamiliar sign-in from their own. No change.
3. **D3: the booking billed on void WIPRO-2026-0004 stays as it is.** It is seed data. The usage row names the invoice honestly ("WIPRO-2026-0004 · Void"), and whether a voided rollup's bookings are billed again is not changed here. No change.

## Deprecated & Superseded Approaches

- Before D1, `GET /billing-account/invoices`, its detail, PDF and CSV export returned every invoice of the organisation to any `billing.read` role, drafts included, and the PDF route refused a draft with 409 to that reader too, which confirmed the draft existed.
