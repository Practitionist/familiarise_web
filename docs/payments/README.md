# Payments Documentation

Complete documentation for the Familiarise payment system — checkout, gateways, refunds, disputes, payouts, webhooks, and more.

> For business-level financial docs (revenue strategy, pricing, metrics, taxes), see [finances/](../finances/).

---

## Overview

| #   | Document                                                                             | Description                                                                                       |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 01  | [Architecture](./01-architecture.md)                                                 | System design, database models, complete data flow                                                |
| 02  | [Setup](./02-setup.md)                                                               | Payment gateway configuration, environment variables                                              |
| 03  | [Status Enums Reference](./03-status-enums-reference.md)                             | All payment, refund, dispute, and booking status values                                           |
| 04  | [B2C/B2B Funding Seam](./04-b2c-b2b-funding-seam.md)                                 | Where the consumer and organisation funding paths meet and diverge                                |
| 05  | [High-Level Design](./05-high-level-design.md)                                       | Four Mermaid diagrams: B2C payment, refunds and payouts, B2B funding, cross-cutting layers        |
| 06  | [B2C Tax Invoices](./06-b2c-tax-invoice.md)                                          | Consumer tax invoices, credit notes, and the outward-supplies register                            |
| —   | [Money Machinery](../enterprise/explainers/money-machinery.md)                       | Cross-rail explainer: B2C and B2B on one spine — data model, sequence, state and posting diagrams |
| —   | [Booking & Money Machinery](../enterprise/explainers/booking-and-money-machinery.md) | End-to-end visual guide with org scoping, permission matrices, and worked numeric ledger examples |

## Subsections

| Section                                                       | Description                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Checkout Flow](./checkout-flow/)                             | 4 appointment types, payment processing, edge cases                         |
| [Gateways](./gateways/)                                       | Stripe and Razorpay setup, architecture, KYC                                |
| [Approval Payments](./approval-payments/)                     | Consultant-approves-first workflow (formerly "pay later")                   |
| [Refunds & Disputes](./refunds-disputes/)                     | Two-phase refund pattern, dispute lifecycle                                 |
| [Cancellations & Rescheduling](./cancellations-rescheduling/) | Refund triggers, payment reuse on reschedule                                |
| [Payouts](./payouts/)                                         | Earnings lifecycle, batch processing, gateway disbursement                  |
| [Webhooks](./webhooks/)                                       | Monitoring, Razorpay webhook schema                                         |
| [Backoffice](./backoffice/)                                   | The Money console: tabs, audited doors, the class-series and reconcile tabs |
