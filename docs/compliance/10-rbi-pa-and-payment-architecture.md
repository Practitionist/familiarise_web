# 10 — RBI PA Master Direction Sep 2025 + payment architecture

> **Status:** 🟡 architecture memo only — likely permitted under current direction; needs CA / RBI-compliance opinion before declaring final. **No migration.**
> **Audience:** payment-platform engineers; ops + finance; CA / legal.
> **Last reviewed:** 2026-05-02
> **Linked issues:** [#737 §10](https://github.com/Practitionist/familiarise_web/issues/737), [#738 Item G](https://github.com/Practitionist/familiarise_web/issues/738) (demoted from architectural to "verify + document").

## What it is

The **RBI Master Direction on Payment Aggregators**, dated **15 September 2025** (RBI/2025-26/79), consolidates the previous PA-Online (PA-O), PA-Physical (PA-P), and PA-Cross-Border (PA-CB) directions into a single framework. The most-cited operative change for marketplaces:

> The previous "split settlement on merchant directions" carve-out has been removed. Payment Aggregators cannot directly settle into seller / sub-merchant accounts unless those sellers are themselves onboarded as **sub-merchants** by the PA.

This affects every marketplace that today receives consumer payments and pays out to a third party (consultant / seller / artist).

**Two paths the direction permits:**

| Path | Mechanism | Onboarding burden | Settlement timing |
|---|---|---|---|
| **A — PA Sub-Merchant** (Razorpay Route) | Each consultant is a fully-KYC'd sub-merchant under Razorpay's PA license. Razorpay handles split settlement at payment time. | High — per-consultant V-CIP, PAN, Aadhaar, bank proof. | Tn+1 to consultant. |
| **B — Nodal / Escrow Account** | Marketplace maintains a nodal account with an SPD bank. Funds enter nodal; debits restricted to merchant payouts, refunds, commission. | Low at consultant level; high at platform level (SPD bank relationship + governance). | Marketplace controls timing. |

**A third de facto path the direction does NOT explicitly forbid:**

| Path | Mechanism | Notes |
|---|---|---|
| **C — Operating account + separate licensed payout** | Consumer → PA → platform's operating account (platform IS the merchant). Platform separately uses a licensed FAA (e.g. RazorpayX Bulk Payouts) to pay consultants from operating funds. | Two separate RBI-licensed flows. Consultant is NOT settled by the PA — they're paid by us via a different licensed product. |

## What architecture does Familiarise actually use?

Verified at `lib/payments/payouts/razorpay-payouts.ts`:

```
Consumer → Razorpay PG (PA license) → Familiarise operating account (we are the merchant)
                                                ↓
                Cron → RazorpayX Payouts API (FAA license) → consultant bank / UPI / Stripe
```

**This is Path C.** Specifically:
- We are NOT using Razorpay Route — `razorpayContactId` + `razorpayFundAccountId` are RazorpayX Bulk Payouts identifiers, NOT Route sub-merchant IDs.
- We are NOT using a nodal account — funds land in the platform's operating account.
- We make a separate, licensed payout via RazorpayX (which has its own RBI authorisation as a Full-fledged Money Changers / Authorised Payment System Operator).

## Why Path C is likely permitted

The Sep 2025 PA Master Direction's prohibition is on **PA-side split settlement to non-merchants**. In our architecture:

1. The PA (Razorpay PG) settles to the **merchant** — that's us. No non-merchant settlement happens from the PA.
2. The payout to the consultant is a separate, licensed transaction via a different RBI-regulated rail (RazorpayX FAA / Stripe Connect).
3. The consultant has no relationship with our PA. They have a relationship with us (their counterparty for the service contract) and with RazorpayX / Stripe (the disbursement rail).

This is the same architecture used by every B2B SaaS marketplace, every freelancer platform, and every digital agency. **Likely permitted** under the new direction.

## What the direction DOES still require

Even on Path C, the direction imposes:

| # | Requirement | Status |
|---|---|---|
| 1 | **Marketplace declaration** to Razorpay | Done at PA onboarding; sign annual self-declaration |
| 2 | **Refund SLA** to consumers (RBI-prescribed timelines) | Implementation pending — see [doc 09](./09-consumer-protection-and-grievance.md) |
| 3 | **Prohibited categories monitoring** | Active — Razorpay flags + we add platform-level ToS |
| 4 | **Data localisation** of payment data | Already enforced — RBI 6 Apr 2018 circular; Razorpay infra is India-based |
| 5 | **PCI-DSS** — never store card numbers / CVV / etc. | Already compliant — we use Razorpay tokens |
| 6 | **Chargeback handling** within 7-day evidence window | Implementation pending — see [doc 09](./09-consumer-protection-and-grievance.md) |
| 7 | **PA-CB approval** for cross-border collections | Razorpay holds it; we enable cross-border settings — see [doc 07](./07-cross-border-flows.md) |

## When it applies

### B2C (consumer marketplace)

- **Applies fully.** Consumer payment + consultant payout architecture sits squarely under this direction.

### B2B (org-sponsored)

- **Applies to org-side payments + consultant payouts.** The org pays via INVOICE / WALLET / LICENSE (different mechanics) but the consultant payout still flows through RazorpayX. Same Path C.

### Cross-border

- See [doc 07](./07-cross-border-flows.md). PA-CB is a separate sub-direction; the Sep 2025 master consolidated it.

## Current code

| Item | What it does | State |
|---|---|---|
| `lib/payments/payouts/razorpay-payouts.ts` | RazorpayX Bulk Payouts API client | ✅ live |
| `lib/payments/payouts/stripe-connect.ts` | Stripe Connect for cross-border consultant payouts | ✅ live |
| `lib/payments/payouts/payout-service.ts` (B2C) | Consultant payout pipeline | ✅ live |
| `lib/payments/payouts/org-payout-service.ts` (B2B) | Org payout pipeline | ✅ live |
| Razorpay PG checkout | ✅ live | |
| Architecture memo | **Missing** — there's no doc explicitly stating "we are on Path C and here's why" | 🟡 |

## Gap

| Gap | Severity |
|---|---|
| No memo at `docs/payments/` documenting the architecture vs the Sep 2025 direction | 🟡 |
| No CA / RBI-compliance opinion validating Path C for our specific facts | 🟡 |
| No annual Razorpay marketplace self-declaration captured + filed | 🟢 (assumed Razorpay does this; verify) |
| No prohibited-categories monitoring at platform-ToS level (Razorpay flags only) | 🟢 |

## Required

### A. Architecture memo (PR 1)

Add `docs/payments/06-pa-master-direction-architecture.md` (or similar):

1. The four paths permitted (A / B / C and C-prime).
2. The path Familiarise uses (Path C).
3. Why Path C is consistent with the Sep 2025 direction.
4. What still applies even on Path C (refund SLA, chargeback handling, PCI-DSS, etc.).
5. The fact-specific risks: a regulator could reclassify the platform as a deemed PA if circumstantial evidence (volume, marketing language, brand integration) suggests we're aggregating rather than facilitating. Mitigate by clear marketing + ToS that we are a marketplace, not a payment intermediary.

### B. CA / legal opinion (PR 2 — out-of-band)

Engage a CA + an RBI-specialised counsel:
- Review the architecture memo.
- Confirm Path C is permitted for our facts.
- Document the opinion with their UDIN / signature.
- File in `docs/compliance/legal-opinions/` (gitignored if confidential).

### C. Annual self-declaration (PR 3)

- Confirm with Razorpay account manager that we sign the marketplace self-declaration annually.
- Calendar a reminder in ops calendar 30 days before each anniversary.

### D. Prohibited categories ToS (PR 4)

- Add to the consultant ToS a list of prohibited service categories (gambling, MLM, crypto, regulated professions where licensing is required).
- Active monitoring: a flag on `ConsultantProfile` that admin can set if a complaint surfaces.

## Decision: do NOT migrate to Path A or B unless

The migration cost (per-consultant V-CIP for Path A, or nodal-account governance for Path B) is significant. Trigger a migration only if:

1. The legal opinion in PR 2 explicitly recommends migration.
2. Regulator inquiry surfaces.
3. A specific feature (e.g. instant settlement, on-platform escrow for high-value services) requires it.
4. The marketplace ratio (commission %) shifts in a way that legally re-classifies us as the deemed seller.

## Acceptance

- Architecture memo in `docs/payments/` published.
- Legal opinion sourced and filed (or "deferred until first regulator inquiry" decision noted).
- Annual self-declaration calendared.
- Prohibited categories ToS published.
- Per-doc inheritance: refund SLA ([doc 09](./09-consumer-protection-and-grievance.md)) + chargeback evidence UI + cross-border PA-CB enablement ([doc 07](./07-cross-border-flows.md)) all closed independently.

## Don't build

| Don't build | Reason |
|---|---|
| Razorpay Route migration | Path A burden is high and not required given Path C is permitted. Wait for legal opinion. |
| Self-custodied escrow | Requires ₹15 cr net worth + RBI approval. Not viable. |
| Direct nodal-account integration with an SPD bank | Path B governance is heavy; only if a specific feature demands it. |

## References

- [RBI PA Master Direction 15 Sep 2025 (FIDC mirror)](https://www.fidcindia.org.in/wp-content/uploads/2025/09/RBI-PAYMENT-AGGREGATORS-DIRECTIONS-15-09-25.pdf)
- [PA Master Directions analysis (Khaitan & Co)](https://www.khaitanco.com/sites/default/files/2025-10/ERGO%20-%20PA%20Master%20Directions%20-%203%20Oct%202025_0.pdf)
- [Razorpay Payment Gateway Compliance 2026](https://razorpay.com/blog/payment-gateway-compliance/)
- [Razorpay KYC Onboarding Guide 2026](https://razorpay.com/blog/payment-gateway-kyc-onboarding-india)
- See also: [07](./07-cross-border-flows.md) (PA-CB), [09](./09-consumer-protection-and-grievance.md) (refund SLA, chargeback handling).
