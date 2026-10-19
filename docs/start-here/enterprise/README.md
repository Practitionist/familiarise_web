---
title: Enterprise system design — reading guide and component map
type: reference
band: start-here
audience: sde1
status: partial
last-reviewed: 2026-10-19
---

# Enterprise system design — reading guide and component map

This collection explains Familiarise's entire enterprise subsystem in nine chapters. It starts with the Prisma model, traces the existing enterprise documentation, and follows the implemented UI, API, transactional helpers, scheduled workers and tests. It includes individual component designs, sequence and data diagrams, numerical examples, failure behavior, and recommendations with alternatives and reasons.

The source baseline is `dev` commit `29fbe05bc`, reviewed on 19 October 2026. “Current” means implemented in that source, with any gate or integration limitation identified. It does not certify production configuration, live database sidecar installation, vendor readiness or legal compliance. Proposed changes are explicitly recommendations; this is a documentation-only change.

## The nine chapters

Read 01 first. Then follow the business question you are trying to answer. The collection is intentionally long; each chapter can also be read independently with its glossary and source map.

| #   | Chapter                                                                            | Main questions                                                                                                                             |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 01  | [Enterprise system design](01-enterprise-system-design.md)                         | What are the system boundaries, data relationships, transaction boundaries and shared invariants?                                          |
| 02  | [Identity, governance and lifecycle](02-identity-governance-and-lifecycle.md)      | Who belongs to an organization, who may act, how do SSO and domain verification work, and what happens at suspension or removal?           |
| 03  | [Commercial axes and programs](03-commercial-axes-and-programs.md)                 | What do the three-, five- and seven-axis views mean, and how do funding, program meters, configuration locks and cycles interact?          |
| 04  | [Checkout and overage](04-checkout-and-overage.md)                                 | How is an allowance consumed, how is the marginal calculated, who pays it, and how do retries, allocation and partial reversal behave?     |
| 05  | [Ledger, billing and settlement](05-ledger-billing-and-settlement.md)              | How do wallets, invoices, purchase orders, earnings, refunds, disputes, organization payouts and TDS fit together?                         |
| 06  | [Dashboards and user journeys](06-dashboards-and-user-journeys.md)                 | Why are there several dashboards, what does each page read or change, and how do payer, attendee, expert and operator perspectives differ? |
| 07  | [Compliance, privacy and data](07-compliance-privacy-and-data.md)                  | What do consent, export, erasure, retention, tax, grievances, breach response and regional attributes actually guarantee?                  |
| 08  | [Operations and integrations](08-operations-and-integrations.md)                   | Which durable rows and workers drive recovery, how are jobs scheduled and locked, and how do external systems and hosting boundaries fail? |
| 09  | [Design decisions and recommendations](09-design-decisions-and-recommendations.md) | Which options are recommended, why, what are the alternatives, and which future behavior changes need an explicit owner decision?          |

## Individual component design lookup

The chapters explain each component's responsibility, durable data, input and output boundaries, authority, failure behavior, and important examples. This table is the lookup index rather than a second copy of those designs.

| Component                                                           | Primary design                                | Connected components                                                                 |
| ------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Global user, personal profiles and typed membership                 | [02](02-identity-governance-and-lifecycle.md) | [Personal and organizational dashboards](06-dashboards-and-user-journeys.md).        |
| Organization capabilities, taxonomies and identity satellites       | [01](01-enterprise-system-design.md)          | [Organization lifecycle](02-identity-governance-and-lifecycle.md).                   |
| Invitation, acceptance, suspension and removal                      | [02](02-identity-governance-and-lifecycle.md) | [Erasure and vendor revocation](07-compliance-privacy-and-data.md).                  |
| Domain verification, SSO, JIT and session enforcement               | [02](02-identity-governance-and-lifecycle.md) | [Provider and runtime boundaries](08-operations-and-integrations.md).                |
| Action permissions and organization scoping                         | [02](02-identity-governance-and-lifecycle.md) | [Dashboard query and command boundaries](06-dashboards-and-user-journeys.md).        |
| Reachable triples, five-axis scenarios and seven-axis configuration | [03](03-commercial-axes-and-programs.md)      | [Recommended commercial recipes](09-design-decisions-and-recommendations.md).        |
| RECOMMENDED, ADVANCED and DISCOURAGED UI guidance                   | [03](03-commercial-axes-and-programs.md)      | [Configuration experience](06-dashboards-and-user-journeys.md).                      |
| Billing account and four funding rails                              | [03](03-commercial-axes-and-programs.md)      | [Funding legs and journal](05-ledger-billing-and-settlement.md).                     |
| Contract, billing subscription, lock and supersession               | [02](02-identity-governance-and-lifecycle.md) | [Program economics and cycles](03-commercial-axes-and-programs.md).                  |
| Licensed seats, credit pools, assignments and cycle rollover        | [03](03-commercial-axes-and-programs.md)      | [Usage and allocation](04-checkout-and-overage.md).                                  |
| Program eligibility, curated panel and price caps                   | [03](03-commercial-axes-and-programs.md)      | [Checkout validation](04-checkout-and-overage.md).                                   |
| Usage ledger, booking utilization and subscription batches          | [04](04-checkout-and-overage.md)              | [Program allowance](03-commercial-axes-and-programs.md).                             |
| BLOCK, CHARGE_ORG and CHARGE_MEMBER                                 | [04](04-checkout-and-overage.md)              | [Collection risk recommendations](09-design-decisions-and-recommendations.md).       |
| Surcharge, GST, marginal split and cycle breaker                    | [04](04-checkout-and-overage.md)              | [Invoice and credit-note accounting](05-ledger-billing-and-settlement.md).           |
| Wallet top-up, sufficient-funds debit and NULL cache                | [05](05-ledger-billing-and-settlement.md)     | [Low-balance alerts and recovery](08-operations-and-integrations.md).                |
| Invoice rollup, purchase-order draw, dunning and credit notes       | [05](05-ledger-billing-and-settlement.md)     | [GST and IRP boundaries](07-compliance-privacy-and-data.md).                         |
| Buyer/host split, rate-card snapshot and collaborators              | [05](05-ledger-billing-and-settlement.md)     | [Expert membership and payout recipient](02-identity-governance-and-lifecycle.md).   |
| Earnings holds, refund clawback and disputes                        | [05](05-ledger-billing-and-settlement.md)     | [Member co-pay](04-checkout-and-overage.md).                                         |
| Organization payout, provider identity, reversal and TDS            | [05](05-ledger-billing-and-settlement.md)     | [Tax evidence and external delivery](07-compliance-privacy-and-data.md).             |
| Immutable journal and SQL sidecar invariants                        | [01](01-enterprise-system-design.md)          | [Detailed postings](05-ledger-billing-and-settlement.md).                            |
| Organization home, members, programs, catalog and appointments      | [06](06-dashboards-and-user-journeys.md)      | [Permission policy](02-identity-governance-and-lifecycle.md).                        |
| Organization billing, purchase orders, payouts and spend            | [06](06-dashboards-and-user-journeys.md)      | [Settlement](05-ledger-billing-and-settlement.md).                                   |
| Organization audit, analytics, support, settings and exports        | [06](06-dashboards-and-user-journeys.md)      | [Data boundaries](07-compliance-privacy-and-data.md).                                |
| Cross-company workspace and platform backoffice                     | [06](06-dashboards-and-user-journeys.md)      | [Operational evidence](08-operations-and-integrations.md).                           |
| Enterprise marketing, contact intake and sales leads                | [06](06-dashboards-and-user-journeys.md)      | [Tenant provisioning](02-identity-governance-and-lifecycle.md).                      |
| Public directory, branding and plan visibility                      | [06](06-dashboards-and-user-journeys.md)      | [Capability versus visibility](02-identity-governance-and-lifecycle.md).             |
| Consent, grievances and breach intake                               | [07](07-compliance-privacy-and-data.md)       | [Compliance completion recommendations](09-design-decisions-and-recommendations.md). |
| Data export generation, authorization and download                  | [07](07-compliance-privacy-and-data.md)       | [Scheduled export worker](08-operations-and-integrations.md).                        |
| Local scrubbing, vendor erasure outboxes and finalization           | [07](07-compliance-privacy-and-data.md)       | [30-minute retry worker](08-operations-and-integrations.md).                         |
| Recording, chat and financial retention                             | [07](07-compliance-privacy-and-data.md)       | [Stream and storage](08-operations-and-integrations.md).                             |
| GST, IRP, TDS, MSME and RBI posture                                 | [07](07-compliance-privacy-and-data.md)       | [Implemented money treatment](05-ledger-billing-and-settlement.md).                  |
| Cleanup registry, ticker, daily batches and Postgres leases         | [08](08-operations-and-integrations.md)       | [Recovery obligations](01-enterprise-system-design.md).                              |
| Outbound webhooks, signing, SSRF and retry                          | [08](08-operations-and-integrations.md)       | [Integration permissions and secrets](07-compliance-privacy-and-data.md).            |
| Email, Novu, Stream and storage delivery                            | [08](08-operations-and-integrations.md)       | [Privacy and revocation](07-compliance-privacy-and-data.md).                         |
| System events, observability and capacity                           | [08](08-operations-and-integrations.md)       | [Measured scaling decisions](09-design-decisions-and-recommendations.md).            |
| Active/standby scheduling and platform portability                  | [08](08-operations-and-integrations.md)       | [Specific recommended corrections](09-design-decisions-and-recommendations.md).      |

## Reading examples correctly

The source seed defines Wipro Limited, LearnPro Academy and IIT Madras in `prisma/seedFiles/14a-create-organizations.ts`. Chapters that discuss those fixtures identify seeded facts. Other people, dates, amounts, tax assumptions and hypothetical commercial terms illustrate the algorithms; they are not observations of customer or production data.

Every financial example should preserve units: ₹1 equals 100 paise, and 10,000 basis points equals 100%. Funding legs, allowance consumption, journal postings and cash settlement are separate quantities. An example that isolates a surcharge or omits tax for clarity states that assumption; the actual checkout derives the applicable treatment.

Some existing enterprise reference pages predate the current code. The new chapters identify material disagreements such as dropped hierarchy fields, the invitation-only member-entry path, public sponsor-directory inclusion, and PERSONAL overage call-site behavior. Follow the new explanation to the cited implementation before relying on an older diagram.

## Relationship to the rest of the documentation

- [Start Here](../README.md) introduces the shared booking and money systems.
- [Enterprise domain references](../../enterprise/README.md) hold deeper contracts, API descriptions and runbooks.
- [Booking HLD](../01-booking-system-hld.md), [money HLD](../02-money-system-hld.md), and [booking and money examples](../03-booking-and-money-machinery.md) explain the shared platform around enterprise.
- [Compliance overview](../../compliance/00-overview.md) contains deeper statutory and filing references.

## Deprecated & Superseded Approaches

Earlier all-in-one enterprise diagrams mixed organizational identity, funding, metering, payout routing and planned integrations into one description. This collection separates those responsibilities while tracing their connections. It does not restore removed organization hierarchy fields, the old single-entry money logs, or obsolete direct-add member flows.

A schema model or route alone is not evidence of an enabled, fully integrated workflow. The chapters distinguish current call paths, gates, gaps and proposals. The recommendations chapter is a reasoned design review, not a feature roadmap presented as implemented behavior.
