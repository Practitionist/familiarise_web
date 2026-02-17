# Payments Documentation

Complete documentation for the Familiarise payment system — checkout, gateways, refunds, disputes, payouts, webhooks, and more.

> For business-level financial docs (revenue strategy, pricing, metrics, taxes), see [finances/](../finances/).

---

## Overview

| # | Document | Description |
|---|----------|-------------|
| 01 | [Architecture](./01-architecture.md) | System design, database models, complete data flow |
| 02 | [Setup](./02-setup.md) | Payment gateway configuration, environment variables |
| 03 | [Status Enums Reference](./03-status-enums-reference.md) | All payment, refund, dispute, and booking status values |
| 04 | [Abandoned Solutions](./04-abandoned-solutions.md) | Previous approaches and why they were abandoned |

## Subsections

| Section | Description |
|---------|-------------|
| [Checkout Flow](./checkout-flow/) | 4 appointment types, payment processing, edge cases |
| [Gateways](./gateways/) | Stripe and Razorpay setup, architecture, KYC |
| [Approval Payments](./approval-payments/) | Consultant-approves-first workflow (formerly "pay later") |
| [Refunds & Disputes](./refunds-disputes/) | Two-phase refund pattern, dispute lifecycle |
| [Cancellations & Rescheduling](./cancellations-rescheduling/) | Refund triggers, payment reuse on reschedule |
| [Payouts](./payouts/) | Earnings lifecycle, batch processing, gateway disbursement |
| [Webhooks](./webhooks/) | Monitoring, Razorpay webhook schema |
