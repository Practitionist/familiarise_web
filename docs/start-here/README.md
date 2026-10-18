---
title: Start Here — Platform Architecture & End-to-End Explainers
type: index
band: index
audience: sde1
status: live
last-reviewed: 2026-10-17
---

# Start Here — Platform Architecture & End-to-End Explainers

This folder is the **entry point for engineers onboarding onto Familiarise** or working across subsystem boundaries. While each domain directory (`docs/booking/`, `docs/payments/`, `docs/enterprise/`, `docs/compliance/`, `docs/observability/`) documents its own vertical in depth, the documents in `docs/start-here/` trace how the whole platform fits together on one spine.

---

## Canonical Explainers

| #   | Document                                                                          | Scope & What You Will Learn                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | [Booking System HLD](./01-booking-system-hld.md)                                  | **The booking system design.** The end-to-end pipeline, the 30-minute atom, allocation modes and who may allocate, the four concurrency layers and the serializable retry engine, state machines, session outcomes, the cron architecture, and the target state of Waves 0–3.                                                |
| 02  | [Money System HLD](./02-money-system-hld.md)                                      | **The finance design.** Price derivation, order mint, the single capture writer, payment legs and the funding-sum trigger, the double-entry ledger and chart of accounts, earnings holds, payouts and TDS, the three refund front doors, credit notes, the refund policy decisions with the India note, and the reconcilers. |
| 03  | [Booking & Money Machinery](./03-booking-and-money-machinery.md)                  | **The scenarios.** The seeded cast, the entity model, the numeric permutation walk-throughs, and nine end-to-end worked examples marked current or after Wave N. The scoping matrices and the 20 ledger permutations it points to live in the enterprise and authorization docs.                                             |
| —   | [Distributed Systems Explained](../architecture/distributed-systems-explained.md) | Upstash Redis distributed locking (`Redlock`), caching layers, and failure-mode posture across serverless functions.                                                                                                                                                                                                         |
| —   | [Prisma Schema Map](../prisma/00-schema-map.md)                                   | Domain-by-domain entity-relationship diagrams of [`prisma/schema.prisma`](../../prisma/schema.prisma).                                                                                                                                                                                                                       |

---

## Where to Go Next by Subsystem

```mermaid
flowchart LR
  START["docs/start-here/<br/>01 booking HLD · 02 money HLD · 03 machinery"] --> BOOK["docs/booking/<br/>5 event types · slot math · rescheduling · state machines"]
  START --> PAY["docs/payments/<br/>checkout · gateways · legs · refunds · payouts · backoffice"]
  START --> ENT["docs/enterprise/<br/>00-foundations through 70-design-decisions (B2B bands)"]
  START --> COMP["docs/compliance/<br/>GST · TDS 194J · RBI PA · DPDP · MSME"]
  START --> OBS["docs/observability/<br/>Sentry · SystemEvent · GitHub Actions failure sink"]
```

| Domain            | Entry Point                                                      | When to Read                                                                                                                |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Booking**       | [`docs/booking/README.md`](../booking/README.md)                 | Modifying slot validation, the allocator (`lib/booking/allocation`), rescheduling, cancellations, or recurring series math. |
| **Payments**      | [`docs/payments/README.md`](../payments/README.md)               | Working on Razorpay/Stripe checkout, `PaymentLeg`, refunds, disputes, payouts, or the Money backoffice console.             |
| **Enterprise**    | [`docs/enterprise/README.md`](../enterprise/README.md)           | Working on organizations, SSO/JIT, contracts, programs, sponsor wallets, B2B invoicing, or the ledger.                      |
| **Compliance**    | [`docs/compliance/00-overview.md`](../compliance/00-overview.md) | Touching GST (SAC `9983`/`9992`), TDS (`194J`), RBI Payment Aggregator rules, DPDP erasure, or MSME ageing.                 |
| **Observability** | [`docs/observability/`](../observability/)                       | Adding Sentry instrumentation, triaging production issues, or inspecting `SystemEvent` / cron failure sinks.                |
