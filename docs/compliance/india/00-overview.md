# India Compliance — Overview

**Status:** Schema-final, logic-stubbed (Arch 4-Modified, Issue #681, April 2026)

## What lives here

This doc series captures every India statutory primitive the Familiarise
enterprise layer must honour, organised by regulation. Every field
mentioned here is **already in the Prisma schema**; only the enforcement
logic is stubbed.

| # | Doc | Regulation |
|---|-----|------------|
| 01 | [GST + IRN](./01-gst-irn.md) | CGST Act, CBIC e-invoice mandate |
| 02 | [TDS sections](./02-tds-sections.md) | Income Tax Act s.194J/194O/194C, s.206AA |
| 03 | [MSME 43B(h)](./03-msme-43b-h.md) | Finance Act 2023 Section 43B(h) |
| 04 | [DPDP consent](./04-dpdp-consent.md) | DPDP Act 2023 + Rules 13 Nov 2025 |
| 05 | [FEMA cross-border](./05-fema-cross-border.md) | FEMA, RBI Master Direction PA 2025 |
| 06 | [PurchaseOrder 3-way match](./06-purchase-order-3way-match.md) | Enterprise AP convention |
| 07 | [**Stubs + implementation plan**](./07-stubs-and-implementation-plan.md) | **Master checklist** |

## Why schema-first, logic-later?

Per Issue #681 AskUserQuestion decision:

> "What I want to ensure is that our schema is top-notch, but the
> implementation can be done later on also, because schema migrations
> are not possible in prod. The schema should be as exhaustive as
> possible, but the implementation can be done later on as well."

This splits India compliance into two tracks:

1. **Schema track (SHIPPED in PR #TBD):** every field on `Organization`,
   `ConsultantProfile`, `OrganizationInvoice`, `OrganizationPayout`,
   `PurchaseOrder`, `ConsentArtifact`, `DataBreach`, `HrisConfig*`.
2. **Logic track (FOLLOW-UP PRs):** `lib/compliance/**` implementations,
   `jobs/compliance/**` crons, API routes, admin dashboards.

The stubs return safe defaults so downstream code compiles. A pilot
customer can be onboarded using manual off-platform compliance; the live
logic lands before the second paying customer.

## Do-NOT-build list (confirmed April 2026)

Building these wastes weeks — each has been abolished, replaced, or is
out-of-scope for our entity type:

| Don't build | Reason |
|---|---|
| TCS Section 206C(1H) collection logic | Removed 1 Apr 2025 |
| Section 206AB higher-TDS-for-non-filers | Omitted 1 Apr 2025 |
| Equalisation Levy (2% cross-border digital, 6% ads) | Both abolished (6% Apr 2025, 2% Aug 2024) |
| ZestMoney no-cost-EMI integration | Shut down Dec 2023. Use Propelld / Eduvanz / Bajaj Finserv / HDFC Credila |
| Self-custodied escrow for org→consultant transfers | RBI PA authorisation required (₹15Cr net worth). Route via RazorpayX / Cashfree |
| Internal IRP integration | Use licensed connector (IRIS / ClearTax / Masters India) |
| Parent-child org hierarchy UI | Schema has columns; no dominant player ships the UI. Defer until a customer asks |
| Separate PEPM billing mode | Healthcare-only (Teladoc 10-K). Use `LICENSED_SEAT` billed monthly |
| BetterAuth `Member` as primary membership | Our `Membership` is the source of truth; BetterAuth `Member` kept for invitation token flow only |
