# Merchant of Record (MoR) Guardrails — Dodo Payments & Polar.sh

> **Status**: **DISQUALIFIED for Core 1:1 Consulting & Two-Sided Marketplace Bookings** (`DODO_PAYMENTS` is fenced in `UNIMPLEMENTED_GATEWAYS` and restricted strictly to hypothetical first-party automated SaaS / digital product SKUs).
> **Last Updated**: 2026-10-05
> **Official Citations**:
> - [Dodo Payments Merchant Acceptance Policy (Prohibited Categories)](https://docs.dodopayments.com/miscellaneous/merchant-acceptance.md)
> - [Dodo Payments Developer Docs (`dodopayments` / `@dodopayments/nextjs`)](https://docs.dodopayments.com/)
> - [Polar.sh Acceptable Use Policy (`docs.polar.sh/merchant-of-record/acceptable-use`)](https://docs.polar.sh/merchant-of-record/acceptable-use)
> - [Polar.sh TypeScript & Next.js SDK (`@polar-sh/sdk`, `@polar-sh/nextjs`)](https://docs.polar.sh/integrate/sdk/typescript)

---

## 1. CRITICAL WARNING: Why MoRs Must NEVER Be Wired to Consultant Bookings or Marketplace Payouts

> [!CAUTION]
> **Do NOT wire `DODO_PAYMENTS` or `Polar.sh` to `Appointment`, `Consultation`, `Subscription` (mentorship), `Webinar`, `Class`, or `ConsultantEarnings`.**
> Doing so violates the explicit Acceptable Use Policies (AUP) of both Dodo Payments and Polar.sh, exposes the platform to immediate account termination, fund freezing, and card-network fines, and breaks Indian tax accounting.

### 1.1 Verified AUP Prohibitions in Dodo Payments (`docs.dodopayments.com/miscellaneous/merchant-acceptance.md`)

Dodo Payments acts as a **Merchant of Record (MoR)** — legally purchasing your digital software product and reselling it to the end buyer. Because card networks and tax authorities hold the MoR liable for fulfillment and tax classification, Dodo Payments **explicitly bans**:

1. **Clause #2 — Manual Digital Services**:
   > *"Services requiring human intervention for delivery (e.g., coaching, freelancing, consulting)."*
2. **Clause #10 — Advisory & Professional Services**:
   > *"Legal, medical, financial, career, or accounting advice."*
3. **Clause #14 — Real-Time Person-to-Person Interaction**:
   > *"Platforms facilitating live 1:1 video/audio sessions."*
4. **Clause #30 — Marketplaces**:
   > *"Platforms that take funds from a buyer and forward them elsewhere; multiple sellers."*
5. **Clause #31 — Ticketing & Booking Services**:
   > *"Selling tickets or time-slot bookings for live events or sessions."*
6. **Strict 0.5% Refund/Dispute Threshold & Card Network Fines**:
   - Dodo's terms state that if your combined **refund, cancellation, or chargeback rate exceeds 0.5%**, Dodo can immediately suspend the account and withhold reserves, and passes through card-network AUP violation fines of **up to \$425,000**. In a live 1:1 consultation marketplace where session rescheduling and cancellations naturally exceed 2%–5%, a 0.5% refund/cancellation ceiling is an automatic tripwire.

### 1.2 Verified AUP Prohibitions in Polar.sh (`docs.polar.sh/merchant-of-record/acceptable-use`)

Polar.sh likewise restricts its Merchant of Record platform strictly to **SaaS, developer tools, and automated digital downloads**, explicitly prohibiting:
- **Item #2 — Human Services**: Any 1:1 consulting, coaching, mentoring, freelancing, or custom human-delivered service.
- **Items #4 & #7 — Marketplaces & Third-Party Seller Revenue Sharing**: Collecting funds on behalf of third-party creators/consultants and splitting or disbursing payouts to them.

### 1.3 Structural & Indian Tax Incompatibilities
Even aside from AUP bans:
1. **No Split / Payout API**: Neither Dodo Payments nor Polar has a `RazorpayX` / `Cashfree Payouts` / `Stripe Connect` API to onboard third-party consultants or disburse earnings to their bank accounts. Both settle a single lumped balance to **one** company bank account.
2. **Gross-vs-Net Tax Distortion**: An MoR remits a single B2B payout to Familiarise and treats **100% of gross marketplace volume (GMV)** as Familiarise's own software export revenue, preventing marketplace pass-through accounting and providing no mechanism for **Section 194-O TDS** withholding on Indian consultants.
3. **Higher Effective Cost**: Dodo Payments charges **4.0% + \$0.40 base + 0.5% subscription + 1.0% international + FX + payout wire fees (~5.5%–7% total)** and discontinued its native INR wallet in 2026 — making it substantially more expensive than **Razorpay International (`~3.54%`)**, **Cashfree (`2.99%`)**, or **Xflow (`0.4%–0.6%`)**.

---

## 2. The ONLY Valid Use Case for Dodo Payments or Polar.sh

Dodo Payments or Polar.sh may **only** be used if Familiarise launches a **100% automated, first-party SaaS or digital product SKU** that satisfies **all** of the following criteria:

- [ ] **100% Automated Delivery**: E.g., an AI mock-interview SaaS subscription, automated resume/code analyzer, or self-paced pre-recorded digital asset owned 100% by Familiarise.
- [ ] **Zero Human 1:1 Delivery**: No live 1:1 video calls, coaching, or manual consulting attached to the SKU.
- [ ] **Zero Third-Party Consultant Splits**: 100% of the revenue belongs to Familiarise (`ConsultantEarnings` is NOT created, and no third-party payout is triggered).
- [ ] **Separate Subdomain / Product Surface**: Underwritten explicitly with the MoR as a first-party SaaS tool so the core marketplace domain is never flagged.

---

## 3. Technical Reference (For Isolated First-Party SaaS Only)

If an isolated first-party SaaS SKU is ever built, full technical details (SDK packages `dodopayments` / `@dodopayments/nextjs` and `@polar-sh/sdk` / `@polar-sh/nextjs`, `Standard Webhooks` `webhook-id` / `webhook-signature` / `webhook-timestamp` verification, and Prisma `BigInt` mapping) are documented in [`.claude/skills/finance/references/gateways/mor-dodo-polar.md`](../../../../.claude/skills/finance/references/gateways/mor-dodo-polar.md).

---

## 4. Related Documents

- [Payment Gateways Overview](../README.md)
- [2026 Payment Gateway Evaluation](../gateway-evaluation-2026.md)
- [Cashfree Payments & Payouts v2](../cashfree/README.md)
- [Tazapay Cross-Border & Foreign Consultant Payouts](../tazapay/README.md)
- [Xflow High-Ticket & B2B Export Collection](../xflow/README.md)
