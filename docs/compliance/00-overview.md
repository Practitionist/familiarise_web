# Compliance — overview

> **Scope:** every statutory obligation that touches **both** the B2B / enterprise org-sponsored flow **and** the B2C / consumer marketplace flow. Payments, payouts, refunds, disputes, invoices, data privacy, grievance handling, and cross-border are all included.
> **Audience:** engineers writing payment / payout / refund / invoice / consent code; admin/finance operators; CA / legal reviewers.
> **Last reviewed:** 2026-06-05 (regulatory claims web-verified as of 2026-06-05)
> **Linked issues:** [#737](https://github.com/Practitionist/familiarise_web/issues/737) (B2C original audit), [#738](https://github.com/Practitionist/familiarise_web/issues/738) (B2C refined scope), the B2B audit threads in GitHub issues.

This series is the canonical compliance reference covering **both rails** of the platform:

| Rail    | What it is                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B2B** | Org-sponsored flows. Organisation pays via INVOICE / WALLET / LICENSE; member books on org's behalf; org receives consolidated invoice + makes consultant payouts via the org payout pipeline. |
| **B2C** | Consumer marketplace. Consultee pays directly with a card or wallet; platform is the e-commerce operator (ECO) under Sec 194O / Sec 52 CGST / Consumer Protection Rules 2020.                  |

Each numbered doc covers a single regulation (or a tightly-scoped cluster) and explains:

- **B2B applicability** — when the rule bites for org-sponsored flows
- **B2C applicability** — when it bites for the consumer marketplace
- **Differences** — where the same regulation applies differently to the two rails

A previous `india/` subfolder under this directory has been merged into this top-level series (the stub-tracking content was outdated after the 2026-05-02 Round 2 wiring of IRP / MSME / DataBreach crons). The do-not-build list, DSC ops notes, and rollout order from that subfolder are now folded into the relevant numbered docs below.

## How this series is organised

| #   | Doc                                                                                                      | Scope                                                                    | Severity    |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- |
| 00  | this file                                                                                                | Overview + index                                                         | —           |
| 01  | [India-first compliance posture](./01-india-first-posture.md)                                            | Posture, scope and open questions for the series                         | —           |
| 02  | [TDS — sections, rates, thresholds](./02-tds-overview.md)                                                | B2B (194J / 194C) + B2C (194O) + non-resident (195)                      | 🔴 Critical |
| 03  | [GST — TCS Sec 52, invoicing, place of supply, HSN, IRN, LUT](./03-gst-overview.md)                      | B2B + B2C invoicing, TCS (not collected; CA-gated), e-invoicing          | 🔴 Critical |
| 04  | [MSME Section 43B(h)](./04-msme-43b-h.md)                                                                | B2B-only — payment to MSME-registered consultants in 15 / 45 days        | 🟠 High     |
| 05  | [Form 140 / 144 / 131 (was 26Q / 27Q / 16A) — TDS returns](./05-tds-quarterly-filings.md)                | Both rails                                                               | 🟠 High     |
| 06  | [Refund & chargeback tax adjustments](./06-refund-and-chargeback-tax-adjustments.md)                     | Both rails — TDS reversal + TCS adjustment + GST credit notes            | 🔴 Critical |
| 07  | [Multi-attendee billing](./07-multi-attendee-billing.md)                                                 | B2C (and B2B webinar/class) per-attendee fan-out                         | 🟠 High     |
| 08  | [Cross-border flows](./08-cross-border-flows.md)                                                         | Non-resident consumers + non-resident consultants, both rails            | 🟠 High     |
| 09  | [DPDP — Act 2023 + Rules 2025](./09-dpdp-and-privacy.md)                                                 | Both rails — consent, DSAR, erasure, retention, breach 72h               | 🔴 Critical |
| 10  | [Consumer Protection / E-Commerce Rules 2020](./10-consumer-protection-and-grievance.md)                 | B2C-primary; B2B inherits Grievance Officer + ODR                        | 🟠 High     |
| 11  | [RBI Payment Aggregator Directions 2025 + payment architecture](./11-rbi-pa-and-payment-architecture.md) | Both rails — Razorpay PG + RazorpayX + Stripe Connect                    | 🟡 Medium   |
| 12  | [RLS design memo](./12-rls-design-memo.md)                                                               | Deferred database row-level-security proposal                            | —           |
| 13  | [Removed / deprecated levies](./13-removed-and-deprecated-levies.md)                                     | EL / 206AB / 206C(1H) — cleanup hygiene                                  | 🟢 Low      |
| 14  | [India compliance calendar](./14-india-compliance-calendar.md)                                           | Filing deadlines for both rails                                          | —           |
| 15  | [Implementation roadmap](./15-implementation-roadmap.md)                                                 | Consolidated B2B + B2C plan                                              | —           |
| 16  | [References](./16-references.md)                                                                         | Authoritative source URLs (CBDT, CBIC, RBI, MeitY, PIB)                  | —           |
| 17  | [India compliance shipping checklist](./17-india-compliance-shipping-checklist.md)                       | P0/P1 shipping checklist across the series                               | —           |
| 18  | [Tax research memo, Oct 2026](./18-tax-research-memo-oct-2026.md)                                        | Income-tax Act 2025 + GST research for the CA, with code status (Q1–Q14) | —           |

## Doc shape

Every numbered doc follows the same template:

```
# Title
> Status / Audience / Linked issues / Last reviewed
## What it is        — regulation summary
## When it applies   — B2B vs B2C applicability
## Current code      — file paths + line numbers + what exists
## Gap               — what's missing or wrong
## Required          — numbered implementation steps
## Acceptance        — how we know it's done
## References        — authoritative URLs
```

Sections may be N/A on a given doc — explicitly noted when so.

## Two-rail map

The same regulation can apply differently to the two rails. This table is the quick lookup:

| Regulation                                                     | B2B (org-sponsored)                                                                    | B2C (consumer marketplace)                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **TDS Sec 194O** (ECO TDS @ 0.10%)                             | N/A — org pays via invoice/wallet/license; no ECO event for the org's own consultants. | **Applies** at every consultant payout. Doc 02.                           |
| **TDS Sec 194J** (professional fees @ 10%)                     | Applies for org → external contractor invoices (admin/legal/CA).                       | N/A — wrong section for consultant payouts (current code uses this; bug). |
| **TDS Sec 194C** (contract works @ 1% / 2%)                    | Edge case — for vendor contracts (e.g. white-label).                                   | N/A.                                                                      |
| **TDS Sec 195** (non-resident payments)                        | Applies if org has non-resident consultants.                                           | Applies for non-resident consultants on B2C side.                         |
| **GST TCS Sec 52** (0.5% by ECO)                               | N/A — no ECO event in B2B.                                                             | Not collected: principal-supplier model (ADR 26). CA-gated. Doc 03, 18.   |
| **GST tax invoice** (Rule 46)                                  | Applies — `OrganizationInvoice` is real.                                               | Applies — `Invoice` is real. Doc 03.                                      |
| **Place of supply** (Sec 12 IGST)                              | Applies — uses org's GST state.                                                        | Applies — needs consumer state at checkout. Doc 03.                       |
| **GST e-invoice / IRN** (Notif 10/2023)                        | Applies if AATO ≥ ₹5 cr — connector live, cron wired.                                  | B2C voluntary pilot only (Sep 2024). Doc 03.                              |
| **MSME Sec 43B(h)** (15/45-day payment)                        | **Applies** — org must pay MSME-registered consultants on time.                        | N/A — consumer pays platform, not consultant directly. Doc 04.            |
| **Form 140 (was 26Q) quarterly TDS return**                    | Applies for org's resident consultants.                                                | Applies for B2C residents. Doc 05.                                        |
| **Form 144 (was 27Q) quarterly TDS return**                    | Applies for org's non-resident consultants.                                            | Applies for B2C non-residents. Doc 05.                                    |
| **Form 131 (was 16A) consultant TDS certificate**              | Applies.                                                                               | Applies. Doc 05.                                                          |
| **GST credit notes** (CGST Sec 34)                             | Applies on org refunds / cancellations.                                                | Applies on consumer refunds. Doc 06.                                      |
| **Refund tax adjustments**                                     | Required — TDS / TCS / GST output reversals.                                           | Required. Doc 06.                                                         |
| **DPDP consent + DSAR**                                        | Applies for org operators.                                                             | Applies for consumers. Doc 09.                                            |
| **DPDP breach reporting (72h)**                                | Applies.                                                                               | Applies. Doc 09.                                                          |
| **Consumer Protection / Grievance Officer**                    | Inherits — same officer covers both rails.                                             | **Applies** — primary obligation. Doc 10.                                 |
| **RBI PA Directions 2025** (RBI/DPSS/2025-26/141, 15 Sep 2025) | Org payouts via RazorpayX → arch memo only.                                            | Consumer payments via Razorpay PG → arch memo only. Doc 11.               |
| **FEMA / PA-CB / Form 15CA-CB**                                | Applies for org's non-resident consultants + cross-border invoices.                    | Applies for B2C non-resident flows. Doc 08.                               |
| **Equalisation Levy** (abolished 2024)                         | Cleanup.                                                                               | Cleanup. Doc 13.                                                          |
| **Sec 206AB / 206C(1H)** (omitted 2025)                        | Cleanup.                                                                               | Cleanup. Doc 13.                                                          |

## Current state at a glance

| Layer                       | Coverage                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B2B / Enterprise schema** | Comprehensive — see the [enterprise documentation](../enterprise/README.md). Schema-final. Compliance helpers live (`lib/compliance/{tds,msme,gst,irp,dpdp}.ts`).                   |
| **B2B compliance crons**    | IRP uploader + MSME alerts + DataBreach 72h all wired to GH Actions schedules (Round 2, 2026-05-02).                                                                                |
| **B2B payouts (RazorpayX)** | Schema final; live submission gated by `ENABLE_LIVE_PAYOUTS` (PR-3 epic).                                                                                                           |
| **B2C consumer flow**       | Audit complete (#737, #738). Two production bugs (TDS section + rate) + multiple gaps (TCS, refund tax adjustments, DPDP consumer layer, Grievance Officer). Implementation queued. |
| **Cross-border**            | Schema fields exist (`form15ca/cb`, `firceRef`, `dtaaRateApplied`). Logic + UI mostly absent on both rails.                                                                         |

## How to use this series

- **Building a new payment / payout / refund feature?** Read 00 + 02 + 03 + 06 first.
- **Adding a new role or onboarding flow?** Read 09 (DPDP) + 10 (Consumer Protection).
- **Doing tax filings ops?** Read 05 + 14.
- **Adding cross-border?** Read 08 + 11 in full before any code.
- **Reviewing the master plan?** 15.
- **Preparing questions for the chartered accountant?** Read 18.

## What this series is NOT

- Not legal advice. Every "applies" / "doesn't apply" verdict is a code-level reading of the regulations against the current product. Talk to a CA / counsel before live filings.
- Not exhaustive of every Indian regulation that could theoretically touch a tech company. Scoped to consumer payments, payouts, refunds, disputes, invoices, data, grievance, cross-border, and the consultant payout pipeline.

## Maintenance

When a regulation changes (Finance Act, CBIC notification, RBI direction, MeitY rules):

1. Update the doc that owns the regulation.
2. Bump "Last reviewed" at the top of that doc.
3. If the change makes existing code wrong, file a `bug` issue with `priority: high` + `production` labels and link from the doc.
4. Update [`14-india-compliance-calendar.md`](./14-india-compliance-calendar.md) if a new deadline appears.
5. Update [`16-references.md`](./16-references.md) if the source URL moves.

## Glossary

| Term                 | Meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| **B2B / B2C**        | Org-sponsored / consumer marketplace rails (this codebase has both).       |
| **ECO**              | E-Commerce Operator (us, under Sec 194O / Sec 52 / E-Commerce Rules 2020). |
| **Participant**      | Consultant earning through the platform (Sec 194O Explanation(b)).         |
| **TDS**              | Tax Deducted at Source (income tax withheld at payout).                    |
| **TCS**              | Tax Collected at Source (GST on supplies under Sec 52).                    |
| **GSTR-8**           | Monthly TCS return for ECOs.                                               |
| **GSTR-1 / 3B**      | Monthly outward-supply returns (registered persons).                       |
| **26Q / 27Q**        | Quarterly TDS returns (resident / non-resident).                           |
| **DPDP**             | Digital Personal Data Protection Act 2023 + Rules 2025.                    |
| **DSAR**             | Data Subject Access Request (rights under DPDP).                           |
| **AFA**              | Additional Factor of Authentication (UPI / e-mandate context).             |
| **IRP / IRN**        | Invoice Registration Portal / Invoice Reference Number (e-invoicing).      |
| **LUT**              | Letter of Undertaking (zero-rated export without IGST payment).            |
| **PA / PA-CB**       | Payment Aggregator / Payment Aggregator Cross-Border.                      |
| **FAA**              | Full-fledged Money Changers Authorisation (RazorpayX category).            |
| **Form 15CA / 15CB** | Pre-remittance forms for cross-border payments.                            |
| **DTAA**             | Double Tax Avoidance Agreement (treaty rate lookup).                       |
| **MSME**             | Micro / Small / Medium Enterprise (Sec 43B(h) 15/45-day rule).             |
| **DPB**              | Data Protection Board (DPDP regulator).                                    |
| **PoS**              | Place of Supply (GST).                                                     |

---

_Curated 2026-05-02 alongside #737/#738 audits. Maintained by whoever ships compliance-touching code; reviewed by finance/legal before any live filing._
