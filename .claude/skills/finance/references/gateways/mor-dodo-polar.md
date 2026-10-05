# Merchant of Record (Dodo Payments & Polar.sh) & US LLC FEMA/ODI Guardrails

**Role in Familiarise**: **Regulatory & Compliance Guardrail Reference**.
**Architecture Guide**: [`docs/payments/gateways/mor-guardrails/README.md`](../../../../docs/payments/gateways/mor-guardrails/README.md).

---

## 1. CRITICAL RULE: Why Dodo Payments & Polar.sh Are Disqualified for Familiarise's Core Marketplace

A **Merchant of Record (MoR)** — including **Dodo Payments (`dodopayments.com`)**, **Polar (`polar.sh`)**, **Lemon Squeezy (`lemonsqueezy.com`)**, **Paddle (`paddle.com`)**, and **Creem (`creem.io`)** — is **NOT** a payment gateway. An MoR legally steps into the transaction as the **Principal Seller of Software**, charges global VAT/GST/Sales Tax in its own name, appears on the buyer's card statement, bears direct card-network liability, and remits a single net bulk payout to the vendor.

Because the MoR is legally liable to Visa/Mastercard and tax authorities for every item sold, **all MoRs strictly prohibit human 1:1 services, consulting, live coaching, and two-sided marketplaces**.

### 1.1 Verified Dodo Payments Acceptable Use Policy (`dodopayments.com/acceptable-use-policy`)
| Prohibited Category | Exact Official Clause | Why It Blocks Familiarise |
| --- | --- | --- |
| **Human Intervention Services** | **Clause #2**: *"Any product or service where significant human intervention is needed to deliver the good/service"* | Blocks 1:1 consultations, live coaching, and personalized mentorship |
| **Marketplaces** | **Clause #10**: *"Marketplaces: Platforms connecting buyers and sellers"* | Familiarise is a two-sided platform connecting consultees and independent consultants |
| **Consulting Services** | **Clause #14**: *"Consulting Services"* | Directly matches our core product (`ConsultationPlan` / `Appointment`) |
| **Coaching** | **Clause #30**: *"Coaching or anything similar"* | Blocks career/interview/executive coaching sessions |
| **Freelance / Professional Services** | **Clause #31**: *"Services: Freelance, design, development, marketing, consulting, or agency services"* | Blocks domain advisory and expert sessions |
| **Enforcement & Fines** | **$425,000 USD Card-Network Fine + Account Freeze + <0.5% Dispute/Refund Cap** | Dodo's AUP warns of a **$425,000 USD fine** for prohibited transactions, immediate reserve freezes, and strict **0.5%** refund/chargeback enforcement |

### 1.2 Verified Polar.sh Acceptable Use Policy (`polar.sh/docs/merchant-of-record/acceptable-use`)
- **Explicitly Permitted**: SaaS subscriptions, downloadable software, digital templates, e-books, pre-recorded self-paced courses, API access.
- **Explicitly Prohibited**:
  - **Item #2 (Human services)**: *"Live courses, synchronous tutoring, or real-time instruction; Consulting, coaching, or mentoring sessions; Custom development, design, or freelance work; Any service requiring scheduled human time or personalized human delivery."*
  - **Item #4 (Marketplaces and platforms)**: *"Multi-vendor marketplaces where third parties sell through your platform; Platforms where you take a commission on transactions between others."*
  - **Item #7 (Events and tickets)**: *"Ticketing for conferences, workshops, or live events (virtual or in-person)."*

### 1.3 Why MoRs Cannot Replace RazorpayX / Cashfree / Tazapay for Consultant Payouts
- MoRs only pay out **net platform revenue to the single registered merchant entity** (`Familiarise`). They have **no split-settlement API** and **no third-party beneficiary payout API** (`RazorpayX` / `Cashfree Payouts` / `Tazapay Payouts` equivalent).

---

## 2. When Dodo Payments (`DODO_PAYMENTS`) or Polar.sh MAY Be Used (Narrow Carve-Out)

If Familiarise launches a **100% automated, first-party digital/SaaS product** with zero human delivery and zero third-party consultant split — such as:
- An AI-powered Resume / Mock-Interview SaaS subscription owned 100% by Familiarise, or
- First-party downloadable templates / e-books / self-paced pre-recorded courses owned 100% by Familiarise —

then an MoR can be used for **that specific digital SKU only**.

### Reference SDK & Webhook Pattern (For Permitted Digital SaaS SKUs Only)
- **Dodo Payments**:
  - NPM: `dodopayments`, `@dodopayments/nextjs`, `standardwebhooks`
  - Env vars: `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PAYMENTS_ENVIRONMENT` (`"test_mode"` | `"live_mode"`)
- **Polar.sh**:
  - NPM: `@polar-sh/sdk`, `@polar-sh/nextjs`
  - Env vars: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_SERVER` (`"sandbox"` | `"production"`)
- **Webhook Verification (`Standard Webhooks` Spec — Used by Both Dodo & Polar)**:
  - Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`
  - Signed payload: `${webhookId}.${webhookTimestamp}.${rawBody}` (HMAC-SHA256 base64 using the base64-decoded `whsec_...` secret).

---

## 3. US LLC + Stripe US: RBI FEMA / ODI & IRS Compliance Guardrails

If an Indian resident founder considers incorporating a **US Delaware LLC or C-Corp** (via Stripe Atlas, Firstbase, or Doola) to access Stripe US:

### 3.1 The RBI FEMA Trap (`Overseas Direct Investment — ODI Rules, 2022`)
1. **LRS vs ODI**: An Indian resident **cannot** legally swipe a personal Indian credit/debit card on Stripe Atlas/Doola to incorporate and subscribe to shares/membership interest of a foreign business entity without routing the investment through an **Authorized Dealer (AD Category-I) Bank** under the **Foreign Exchange Management (Overseas Investment) Rules, 2022 (ODI)**.
2. **Mandatory Before Remitting Capital**:
   - File **Form FC** through the AD Bank,
   - Obtain an RBI **Unique Identification Number (UIN)** before sending equity capital,
   - Receive share/membership certificates within 6 months, and
   - File an **Annual Performance Report (APR)** verified by a Chartered Accountant by December 31 every year.
3. **Consequences of Unreported Card Incorporation**: Treated as an unauthorized capital account transaction under FEMA Section 13 (requiring RBI compounding penalties and legal regularization).

### 3.2 Annual US + India Overhead (`~$2,500–$5,000+/year`)
- **IRS Form 5472 + Pro-Forma Form 1120**: Mandatory every year for any 100% foreign-owned US single-member LLC (even with `$0` revenue). The statutory IRS penalty for late or missed Form 5472 is **$25,000 USD per form**.
- **Delaware Franchise Tax + Registered Agent**: `$300/yr` (LLC) or `$450+/yr` (C-Corp) + `$100–$300/yr` agent fee.
- **No Indian INR Consultant Payouts**: Stripe US / Stripe Connect cannot pay domestic INR bank accounts or UPI VPAs of third-party Indian consultants; funds must still be repatriated to the Indian entity under an inter-company transfer pricing agreement and disbursed via RazorpayX / Cashfree Payouts.
- **Decision Rule**: Defer US entity formation until international GMV consistently exceeds **`$20,000–$30,000/month`** (`₹20L–₹25L/mo`).
