# ADR: One payment rail — why the repository integrates Razorpay and RazorpayX only

- **Status**: Accepted (owner decision, 2026-11-09). This record becomes the home for gateway research that was done on 2026-10-05 and kept on Notion pages that are now deleted.
- **Date**: 2026-11-09
- **Author**: Platform engineering
- **Related**: [Money decisions](../finance/90-decisions/README.md) (the gateway section and its ban on describing another gateway as live or planned), [Razorpay gateway and currency](../finance/10-money-in/04-razorpay-gateway-and-currency.md), [RBI payment aggregator posture](../enterprise/40-compliance-and-data/07-rbi-payment-aggregator-posture.md), [Schema freeze and migration cutover](../prisma/02-schema-freeze-and-migration-cutover.md) (the `STRIPE` and `DODO_PAYMENTS` KEEP rows)

## Context

A marketplace that collects money for independent experts has to pick the rail that collects it, and the choice is hard to undo because the ledger, the refund paths, the payout rail and the tax documents all hang off it. The platform sells domestic sessions to mostly Indian buyers, settles in INR, and pays Indian experts through RazorpayX. A buyer abroad pays the same INR order with an international card (`routeGateway`, `lib/payments/gateway-router.ts`).

On 2026-10-05 the owner had the alternatives researched: Stripe directly, a US company with Stripe US, the merchant-of-record platforms, and three other Indian or cross-border vendors. This record keeps the conclusions an engineer needs, which is why the repository has exactly one integrated rail, so that nobody re-opens the question without a new trigger. Vendor fee schedules change quickly and are the owner's to track, so fees appear here only as "published on 2026-10-05" when a conclusion depends on one.

## Decision

Razorpay is the only integrated collection gateway and RazorpayX is the only integrated payout rail. Nothing else has code behind it. The sections below record what was rejected and why, what is deferred and what would reopen it.

### The code state that enforces it

- The `PaymentGateway` enum still carries `STRIPE` and `DODO_PAYMENTS`, but `UNIMPLEMENTED_GATEWAYS` (`lib/payments/constants.ts`) lists both, and `assertGatewayUsable` (`lib/payments/validation/gateway-guards.ts`) throws `UnsupportedGatewayError` on any money path that receives one. The enum values survive as labels because rows, seed data and readers still hold them; the KEEP rows in the [schema freeze document](../prisma/02-schema-freeze-and-migration-cutover.md) say who reads them.
- `assertInrSettlement` (`lib/payments/validation/currency-guards.ts`) makes INR the only settlement currency.
- Cashfree, Tazapay and Xflow appear in no gateway code. The one trace is an unused `PayoutRailProvider.CASHFREE_PAYOUTS` enum value.

### Rejected

**Stripe, integrated directly.** Stripe was removed from the code on 2026-10-04. The research found that Stripe has been invite-only for new accounts in India since May 2024, that it offers no UPI, and that its international fees were high for the ticket sizes sold here. A rail that cannot take UPI loses most Indian checkouts.

**A US LLC with Stripe US.** Not recommended. Setting up a US entity to get Stripe would put an Indian-owned business under a stack of obligations that outweigh the benefit: outward direct investment reporting under FEMA (Form FC, with an RBI unique identification number before any remittance), the round-tripping restriction in Rule 19(3) of the Overseas Investment Rules, disclosure of the foreign asset under the Black Money Act (Schedule FA), an annual Form APR, IRS Form 5472 for a foreign-owned US company, Delaware franchise tax, and transfer pricing documentation in India (Form 3CEB) for dealings between the two entities. Separately, Stripe Connect cross-border payouts do not support India as a payout destination, so the expert side of a marketplace could not be paid that way anyway. The revisit trigger is international GMV above a threshold the owner sets: value kept in Notion (Familiarise / Finance and Pricing).

**Merchant-of-record platforms (Dodo Payments, Polar.sh, Lemon Squeezy, Paddle, Creem).** All five were rejected for the same reasons, which are structural and do not depend on any one vendor's fee. First, their acceptable-use policies exclude one-to-one consulting and other human services, and multi-vendor marketplaces, which is the whole business here (cited by category because the clause numbers disagreed between the sources read). Second, none offers a split or payout API, so money settles once to the platform and cannot be divided between the platform and the expert at the source. Third, a merchant of record books one hundred percent of the gross order value as its own revenue, which does not fit the way this platform withholds tax under Section 194-O as an e-commerce operator (see [TDS rules and returns](../finance/60-tax/03-tds-rules-and-returns.md)). Fourth, at least one of them (Dodo) freezes accounts whose refund or chargeback rate passes 0.5 percent, a threshold a marketplace with consultation refunds could cross. `DODO_PAYMENTS` therefore exists only as a refused enum label.

### Deferred, not rejected

These have no code and no plan. Each has a trigger that would justify evaluating it again.

| Option   | What it would be for                                                                   | Why it is not integrated                                                                                     | Revisit when                                                                                        |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Cashfree | A full-stack domestic backup for collections and payouts                               | One domestic rail is enough until its failure costs more than a second integration                           | A second domestic rail is needed, for resilience or a commercial reason                             |
| Tazapay  | Paying non-Indian consultants without paying foreign exchange twice                    | Every expert is Indian and paid in INR through RazorpayX                                                     | Foreign consultants are onboarded                                                                   |
| Xflow    | Low-cost export collections for high-ticket packages and business-to-business invoices | Its per-transaction minimum fee, as published on 2026-10-05, makes it unsuitable for small consumer bookings | International packages above a threshold the owner sets (value kept in Notion, Finance and Pricing) |

### What Razorpay brings

Razorpay is the integrated rail because it takes UPI and cards and settles in INR, and because the platform's regulatory posture is built on it: a plain payment-gateway relationship with settlement into the platform's own account, and RazorpayX paying experts out of the platform's own account after the fact. That is why the platform is not itself a payment aggregator; the conditions are in the [RBI posture memo](../enterprise/40-compliance-and-data/07-rbi-payment-aggregator-posture.md). The Reserve Bank's 2025 Master Direction on payment aggregators defines three authorisation categories (PA-Physical, PA-Online and PA-Cross Border), and a platform that takes this shape of rail relies on its gateway holding the right one. Fees are in the [gateway page](../finance/10-money-in/04-razorpay-gateway-and-currency.md) and the finance docs, not restated here.

## Why none of this is documented as planned

The agents, skills and documents that designed against Cashfree, Tazapay, Xflow and the merchant-of-record platforms were deleted on 2026-10-23 under the no-speculative-abstractions rule (root `AGENTS.md`, section 1, rule 2). The [money decisions page](../finance/90-decisions/README.md) bans calling any of them live or planned, and this record is consistent with that ban: it records an evaluation and its triggers, not a roadmap. If a trigger fires, the work starts as a new decision record, and only then as code.

## Consequences

- A new gateway never enters the repository on the strength of a vendor pitch. It needs a trigger from the table above and an owner decision first.
- Anyone reading `STRIPE` or `DODO_PAYMENTS` in a filter, label or seed row should treat it as a historical label, not a rail.
- The tax and RBI reasoning above is the engineering context, not advice; the accountant's working notes stay in Notion (Familiarise / Tax & CA Working Notes).

## Deprecated & Superseded Approaches

- **Stripe as a second live gateway** (removed 2026-10-04), together with its checkout-session code, webhook handler and forex-fee table.
- **"Lemon Squeezy and XFlow were evaluated in March 2026, rejected and removed"** in the README: the merchant-of-record platforms were rejected as above, but Xflow is deferred, not rejected. The README now points here.
- **A "Future Phases" multi-currency plan** (Wise payouts, EU VAT, Australian GST): not scheduled and not code.
