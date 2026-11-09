# Compliance — overview

> **Scope:** the data-protection, consumer-protection and regulatory-posture documents for the platform, plus a map to where the tax and money rules live.
> **Audience:** engineers writing consent, erasure, retention, payment or payout code; admin and finance operators; CA and legal reviewers.
> **Not legal advice.** Every "applies" verdict is a code-level reading of the rule against the current product. Confirm with a CA or counsel before live filings.

## What lives where

| Topic                                                             | Document                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Posture, scope and open questions for this folder                 | [India-first compliance posture](./01-india-first-posture.md)                                       |
| DPDP Act 2023 and Rules 2025: consent, DSAR, erasure, breach 72h  | [DPDP and privacy](./02-dpdp-and-privacy.md)                                                        |
| Consumer Protection (E-Commerce) Rules 2020, Grievance Officer    | [Consumer protection and grievance](./03-consumer-protection-and-grievance.md)                      |
| Row-level security proposal (deferred)                            | [RLS design memo](./04-rls-design-memo.md)                                                          |
| Filing deadlines (DPDP rows and the statutory calendar)           | [India compliance calendar](./05-india-compliance-calendar.md)                                      |
| Dark-pattern self-audit, findings and the displayed certificate   | [Dark-pattern self-audit](./07-dark-pattern-self-audit.md)                                          |
| Tax model: principal supplier, Section 194-O, what we do not levy | [Tax explainer](../finance/60-tax/01-tax-explainer.md)                                              |
| GST invoices, credit notes, place of supply, e-invoicing          | [GST invoices and credit notes](../finance/60-tax/02-gst-invoices-and-credit-notes.md)              |
| TDS rules, rates, quarterly returns                               | [TDS rules and returns](../finance/60-tax/03-tds-rules-and-returns.md)                              |
| MSME Section 43B(h), statutory exports, tax calendar jobs         | [MSME, statutory exports and calendar](../finance/60-tax/04-msme-statutory-exports-and-calendar.md) |
| Consent state model and retention engine                          | The `compliance` skill, `.claude/skills/compliance/SKILL.md`                                        |

## The two rails

The platform has two funding rails. **B2B** is organisation-sponsored: the organisation pays by invoice, wallet or licence and receives a consolidated GST invoice. **B2C** is the consumer marketplace: the consultee pays by card and the platform issues a consumer tax invoice as principal supplier. Rules that differ by rail are explained in the finance tax pages above; the DPDP, consumer-protection and grievance obligations apply to both.

## RBI payment-aggregator posture

The platform is the merchant of record, not a payment aggregator. Consumer payments go through Razorpay's payment gateway, which holds the RBI payment-aggregator authorisation, and settle into the platform's own operating account. Consultants and organisations are then paid by a separate licensed rail, RazorpayX payouts, executed from that account. The platform never aggregates funds for merchants it has no contract with and never holds PA escrow.

The RBI (Regulation of Payment Aggregators) Directions, 2025 prohibit a PA from aggregating funds for, or settling to, parties it has no merchant contract with. That prohibition is why this split is believed to be permitted: the gateway settles only to its merchant, and the consultant relationship runs through the platform's own service contract and a different licensed rail. The architecture memo is not a legal opinion; a CA or RBI-compliance review is still the gate before treating it as final.

What the Directions still require on this architecture: the marketplace declaration to the gateway, refund timelines for consumers, prohibited-category monitoring, payment-data localisation (the 2018 RBI storage directive, met because the gateway holds the data in India), no card data in our systems (we hold only gateway tokens), and the chargeback evidence window. Cross-border collection is enabled through the gateway's own PA-CB approval.

## Maintenance

When a regulation changes, update the document that owns it, bump its "Last reviewed" line, and file a `bug` issue if existing code becomes wrong. Update the compliance calendar when a deadline appears.
