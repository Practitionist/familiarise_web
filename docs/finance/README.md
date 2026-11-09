---
title: Finance documentation
type: reference
band: index
audience: sde2
status: live
last-reviewed: 2026-10-23
---

# Finance documentation

This folder documents the money subsystem: how a rupee gets in, how it is recorded, how it is refunded or paid out, how organisations fund bookings, how tax is handled, and how operators keep all of it correct. Start with the explainer in [start-here/02-money-system-hld.md](../start-here/02-money-system-hld.md), which takes twenty to thirty minutes and needs no code. The pages below are the depth behind it.

## Terms used throughout

- A **refund** returns money for a booking. A **dispute** is always a gateway chargeback (the `Dispute` model, raised by the buyer's bank through Razorpay). A **service complaint** is a `SupportCase` a buyer files with support; it can end in a refund through a recommendation that a second operator decides, but it is not a dispute.
- The gateways we run are **Razorpay** (orders, webhooks, refunds, disputes) and **RazorpayX** (payouts and fund-account validation). Settlement is INR only. No other gateway has code; see [money decisions](90-decisions/README.md).
- Amounts are integer paise in the database (₹1 = 100 paise) and splits are integer basis points (10,000 = 100 %).

Pricing levers (list price, discount codes, the welcome discount, credits, GST display and the platform fee) have their own folder: [pricing](../pricing/README.md). Its [one order, one pipeline](../pricing/01-one-order-pipeline.md) page shows how they combine on a single order.

## Reading paths

| If you are                                      | Read, in order                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New to the codebase                             | [Money system explainer](../start-here/02-money-system-hld.md), [money map](00-overview/01-money-map.md), [glossary and status reference](00-overview/02-glossary-and-status-reference.md), then [checkout and pricing](10-money-in/01-checkout-and-pricing.md)                        |
| Changing checkout or webhooks                   | [Capture confirmation and webhooks](10-money-in/02-capture-confirmation-and-webhooks.md), [webhook reference](10-money-in/03-razorpay-webhook-reference.md), [gateway and currency](10-money-in/04-razorpay-gateway-and-currency.md)                                                   |
| Changing the ledger or a posting                | [Double-entry model](20-ledger/01-double-entry-model.md), [chart of accounts](20-ledger/02-chart-of-accounts.md), [payment legs](20-ledger/03-payment-legs.md), [postings](20-ledger/04-postings.md)                                                                                   |
| Working on organisations and sponsored bookings | [Funding rails](50-b2b/01-funding-rails-and-permutations.md), [wallet](50-b2b/02-wallet-and-top-ups.md), [rate cards and overage](50-b2b/03-rate-cards-and-overage.md), [invoices](50-b2b/04-invoices-purchase-orders-and-dunning.md), [worked examples](50-b2b/05-worked-examples.md) |
| On call for money                               | [Money runbooks](70-operations/05-money-runbooks.md), [webhook recovery](70-operations/04-webhook-recovery.md), [ledger drift runbook](70-operations/06-ledger-drift-runbook.md), [scheduled jobs](70-operations/01-scheduled-jobs.md)                                                 |
| An operator or admin                            | [Admin money doors](70-operations/02-admin-money-doors.md), [maintenance gate and recovery](70-operations/03-maintenance-gate-and-recovery.md)                                                                                                                                         |
| Taking the platform live                        | [Go-live checklist](70-operations/07-go-live-checklist.md)                                                                                                                                                                                                                             |
| Looking for the reason behind a rule            | [Money decisions](90-decisions/README.md)                                                                                                                                                                                                                                              |

## Sections

### 00-overview

- [01-money-map.md](00-overview/01-money-map.md): the diagram-first system map.
- [02-glossary-and-status-reference.md](00-overview/02-glossary-and-status-reference.md): glossary and every money status enum.

### 10-money-in

- [01-checkout-and-pricing.md](10-money-in/01-checkout-and-pricing.md)
- [02-capture-confirmation-and-webhooks.md](10-money-in/02-capture-confirmation-and-webhooks.md)
- [03-razorpay-webhook-reference.md](10-money-in/03-razorpay-webhook-reference.md)
- [04-razorpay-gateway-and-currency.md](10-money-in/04-razorpay-gateway-and-currency.md)
- [05-approval-payments.md](10-money-in/05-approval-payments.md)

### 20-ledger

- [01-double-entry-model.md](20-ledger/01-double-entry-model.md)
- [02-chart-of-accounts.md](20-ledger/02-chart-of-accounts.md)
- [03-payment-legs.md](20-ledger/03-payment-legs.md)
- [04-postings.md](20-ledger/04-postings.md)
- [05-gateway-clearing-and-settlement.md](20-ledger/05-gateway-clearing-and-settlement.md)
- [06-integrity-and-reconciliation.md](20-ledger/06-integrity-and-reconciliation.md)
- [07-referral-credits.md](20-ledger/07-referral-credits.md)

### 30-refunds-disputes

- [README.md](30-refunds-disputes/README.md)
- [01-refunds.md](30-refunds-disputes/01-refunds.md)
- [02-chargebacks.md](30-refunds-disputes/02-chargebacks.md)
- [03-service-complaints-and-remedies.md](30-refunds-disputes/03-service-complaints-and-remedies.md)

### 40-payouts

- [01-how-payouts-work.md](40-payouts/01-how-payouts-work.md)
- [02-earnings-lifecycle.md](40-payouts/02-earnings-lifecycle.md)
- [03-consultant-payouts.md](40-payouts/03-consultant-payouts.md)
- [04-razorpayx.md](40-payouts/04-razorpayx.md)
- [05-org-payouts-and-clawbacks.md](40-payouts/05-org-payouts-and-clawbacks.md)
- [06-tds-withholding.md](40-payouts/06-tds-withholding.md)

### 50-b2b

- [01-funding-rails-and-permutations.md](50-b2b/01-funding-rails-and-permutations.md)
- [02-wallet-and-top-ups.md](50-b2b/02-wallet-and-top-ups.md)
- [03-rate-cards-and-overage.md](50-b2b/03-rate-cards-and-overage.md)
- [04-invoices-purchase-orders-and-dunning.md](50-b2b/04-invoices-purchase-orders-and-dunning.md)
- [05-worked-examples.md](50-b2b/05-worked-examples.md)

### 60-tax

- [01-tax-explainer.md](60-tax/01-tax-explainer.md)
- [02-gst-invoices-and-credit-notes.md](60-tax/02-gst-invoices-and-credit-notes.md)
- [03-tds-rules-and-returns.md](60-tax/03-tds-rules-and-returns.md)
- [04-msme-statutory-exports-and-calendar.md](60-tax/04-msme-statutory-exports-and-calendar.md)
- [05-gst-registration-and-tax-regime.md](60-tax/05-gst-registration-and-tax-regime.md)

### 70-operations

- [01-scheduled-jobs.md](70-operations/01-scheduled-jobs.md): the money jobs by schedule, generated from the ticker.
- [02-admin-money-doors.md](70-operations/02-admin-money-doors.md)
- [03-maintenance-gate-and-recovery.md](70-operations/03-maintenance-gate-and-recovery.md)
- [04-webhook-recovery.md](70-operations/04-webhook-recovery.md)
- [05-money-runbooks.md](70-operations/05-money-runbooks.md)
- [06-ledger-drift-runbook.md](70-operations/06-ledger-drift-runbook.md)
- [07-go-live-checklist.md](70-operations/07-go-live-checklist.md)

### 90-decisions

- [README.md](90-decisions/README.md): the index of the money ADRs, which stay in `docs/enterprise/70-design-decisions/`.

## How these pages are written

Each page declares one type in its frontmatter: an explanation says why, a reference says exactly what, a how-to gives a procedure, and a tutorial follows one flow with numbers. Behaviour is described only if it is on `dev`; anything else is labelled. Every rule names what enforces it (a database constraint, a compare-and-set helper, a lock, an application check, or a sweep). Pages cite files and functions, never line numbers.
