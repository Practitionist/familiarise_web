# Payment Gateway Evaluation (2026) — India, Cross-Border, Payouts & MoR Audit

> **Last Updated**: 2026-10-05
> **Supersedes**: `gateway-evaluation-mar-2026.md`
> **Scope**: Regulatory, technical, and Acceptable Use Policy (AUP) evaluation of domestic and international payment gateways, payout engines, US entity structures, and Merchant of Record (MoR) platforms for Familiarise.

---

## 1. Executive Summary & Architectural Verdict

| Use Case / Corridor | Selected / Recommended Rail | Status in Codebase | Why |
|---|---|---|---|
| **Domestic India Pay-ins (B2C & B2B)** | **Razorpay PG** (`RAZORPAY`) | **Live (Primary)** | 0% UPI, ~2% + GST cards/netbanking, RBI PA-O/PA-P/PA-CB licensed, saved cards via CoFT (`ensureRazorpayCustomer`). |
| **Global Pay-ins (< \$500 B2C)** | **Razorpay International** (Cards + Apple Pay + PayPal + MoneySaver) | **Live (Primary)** | Holds final RBI PA-CB license (Dec 2, 2025; up to ₹25L/txn), supports 160+ currencies, Apple Pay (70+ countries, 0% extra fee), PayPal, and auto-generates FIRS / e-FIRA for GST `EXPORT_LUT`. |
| **Domestic India Consultant & Org Payouts** | **RazorpayX Payouts** | **Live (Primary)** | Contacts + Fund Accounts + Penny Drop & Reverse Penny Drop (`validation_type: "upi_intent"`) + `POST /v1/payouts` (`X-Payout-Idempotency`), Section 194-O TDS. |
| **Full-Stack India + Cross-Border Backup (Pay-ins + Payouts + Splits)** | **Cashfree Payments & Payouts v2** (`CASHFREE`) | **Planned #1 Backup** | First fintech with final RBI PA + PA-CB licenses (July 2024). Direct 1:1 fallback for **both** Razorpay PG (`cashfree-pg` v5, 1.95% domestic / 2.99% intl) **and** RazorpayX Payouts (`Cashfree Payouts v2` + `Secure ID` Reverse Penny Drop). |
| **Global Local-Rail Pay-ins + Foreign (Non-Indian) Consultant Payouts** | **Tazapay** (`TAZAPAY`) | **Planned Global Marketplace Rail** | Explicitly supports consulting, edtech, and marketplaces. Collects via 80+ local rails (US ACH, EU SEPA, UK FPS) + cards, settles INR with 1-day e-FIRA, and holds USD/EUR/GBP balances to pay **foreign (non-Indian) consultants in 70+ countries** (`$2–$5` fee) without double-FX loss (`4%–6%`) or Indian Sec 393 / Forms 145 & 146 (pre-cutover Sec 195 / Forms 15CA & 15CB) friction. |
| **High-Ticket International Packages (\$500+) & B2B Org Invoices** | **Xflow** (`XFLOW`) | **Planned High-Ticket Export Rail** | Founded by ex-Stripe India head, backed by Stripe, holds final RBI PA-CB license, runs on Stripe + JPMorgan rails. Charges **0.4%–0.6% with 0% FX markup** (mid-market rate) and 24-hour automated e-FIRA (\$12 min fee on Starter plan ≤ \$2,000). |
| **US Delaware LLC / C-Corp + Stripe US** | **Deferred until Intl GMV > \$20k/mo** | **Not Recommended pre-\$250k/yr** | Triggers RBI **FEMA Overseas Direct Investment (ODI)** rules (`Form FC` + `UIN` + annual audited financials for `Form APR`), **\$25,000 IRS Form 5472 penalty risk**, ₹1.2L–₹3.0L/yr fixed compliance cost, and **Stripe Connect Cross-Border Payouts still does NOT support India (`IN`)**. |
| **Merchant of Record (MoR)** (`Dodo Payments`, `Polar.sh`, `Lemon Squeezy`, `Paddle`, `Creem`) | **Disqualified for Marketplace & 1:1 Consulting** | **`DODO_PAYMENTS` fenced in `UNIMPLEMENTED_GATEWAYS`** | Every major MoR **explicitly prohibits 1:1 human consulting/coaching and multi-vendor marketplaces** in their AUPs (Dodo Clauses #2, #10, #14, #30, #31 carry up to **\$425,000 fines** and a **0.5% refund/dispute cap**; Polar Items #2, #4, #7). Structurally lacks consultant split/payout APIs and Sec 393 / 194-O TDS handling. |

---

## 2. Why Opening a US Entity for Stripe US Is a Trap Below \$20k/Month International GMV

### 2.1 Stripe India Status (2024–2026)
- Since May 2024, **Stripe India has remained strictly invite-only** due to RBI Payment Aggregator (PA) and Payment Aggregator – Cross Border (PA-CB) licensing and mandatory Video KYC (V-CIP) onboarding requirements ([Stripe India FAQ](https://support.stripe.com/questions/india-faq)).
- Even for invited Indian accounts, Stripe Connect in India cannot execute cross-border marketplace splits, and international card fees + currency conversion total **~6.5%+**.

### 2.2 The FEMA / ODI Legal Reality for Indian Resident Founders
Incorporators such as Stripe Atlas, Doola, and Firstbase market "$500 credit card formation" for a Delaware LLC or C-Corp. For Indian tax residents, **acquiring equity or membership interest in a foreign entity is Overseas Direct Investment (ODI)** under the *Foreign Exchange Management (Overseas Investment) Rules, 2022* — **not** a casual Liberalised Remittance Scheme (LRS) expense:

1. **Mandatory AD Bank Routing (`Form FC` + RBI `UIN`)**:
   - Before remitting even \$1 of initial capital/subscription to a foreign LLC or C-Corp, an Indian resident must file **`Form FC`** through a designated **Authorized Dealer (AD Category-I) Bank**, submit a valuation certificate, and obtain a 13-digit **RBI Unique Identification Number (UIN)**.
   - Paying incorporation + capital via an Indian personal credit card without a UIN is a **FEMA contravention** subject to compounding penalties up to **300%** (FEMA Section 13), and Indian banks routinely freeze inward/outward remittances when a UIN is missing.
2. **Round-Tripping / Step-Down Subsidiary Restriction (OI Rule 19(3))**:
   - Under the 2022 OI Rules, an Indian resident **individual** is prohibited from holding equity in a foreign entity that in turn owns a step-down operating subsidiary in India unless structured via an **Indian Parent Company** (`Indian Pvt Ltd → US Subsidiary`) or with specific RBI clearance.
3. **Black Money Act (Schedule FA)**:
   - Every Indian resident director, signatory, or beneficial owner of a foreign LLC/C-Corp or US bank account (Mercury/Relay) must disclose it in **Schedule FA (Foreign Assets)** of their Indian Income Tax Return. Omission triggers a mandatory **₹10,00,000/year penalty** under Sections 42/43 of the *Black Money (Undisclosed Foreign Income and Assets) and Imposition of Tax Act, 2015* — even if the US entity had \$0 revenue.
4. **Annual Audited Financials & IRS Form 5472 (\$25,000 Penalty)**:
   - **RBI Annual Performance Report (`Form APR`)**: Must be filed via the AD Bank by **December 31 every year**, requiring **CPA-audited financial statements** of the US entity unless exempted.
   - **IRS Form 5472 + Pro-Forma Form 1120**: Mandatory every year for a foreign-owned US single-member LLC (Disregarded Entity), even with \$0 revenue. Filing late or inaccurately triggers an **automatic \$25,000 IRS penalty**.
   - **Delaware Franchise Tax**: Increased to **\$400/year** for Delaware LLCs (as of August 2026) and **\$225–\$450+/year** for C-Corps.
   - **Transfer Pricing (`Form 3CEB`)**: Moving funds from the US entity to the Indian entity requires an inter-company service agreement with a **10%–18% cost-plus markup**, creating **~2.5%–4.5% unrecoverable Indian corporate tax drag** plus CA Form 3CEB audit fees.
5. **Stripe Connect Cannot Pay Indian Consultants from the US**:
   - Per [Stripe Connect Cross-Border Payouts documentation](https://docs.stripe.com/connect/cross-border-payouts), **India (`IN`) is NOT a supported recipient country** for cross-border Connect payouts. A US Stripe account cannot split or disburse INR to Indian consultants.

---

## 3. Why Merchant of Record (MoR) Platforms Are Disqualified for Familiarise's Marketplace

We audited the official **Acceptable Use Policies (AUP)** and payout mechanics of **Dodo Payments**, **Polar.sh**, **Lemon Squeezy**, **Paddle**, and **Creem.io**.

### 3.1 Explicit AUP Prohibitions on 1:1 Consulting & Marketplaces

| MoR Platform | 1:1 Consulting / Coaching / Mentoring | Live Webinars / Cohort Classes | Two-Sided Marketplace (3rd-Party Consultants) | Official Policy Citation & Penalties |
|---|---|---|---|---|
| **Dodo Payments** (`dodopayments.com`) | **PROHIBITED** (Clauses #2, #10, #14) | **PROHIBITED** (Clauses #14, #31) | **PROHIBITED** (Clause #30) | [Dodo Merchant Acceptance Policy](https://docs.dodopayments.com/miscellaneous/merchant-acceptance.md):<br>• **#2 Manual Digital Services**: *"Services requiring human intervention for delivery (e.g., coaching, freelancing, consulting)"*<br>• **#10 Advisory & Professional Services**<br>• **#14 Real-time Person-to-Person Interaction**<br>• **#30 Marketplaces**: *"Platforms that take funds from a buyer and forward them elsewhere; multiple sellers"*<br>• **#31 Ticketing & Booking Services**<br>• **Penalties**: Fines up to **\$425,000** + immediate freeze if refund/cancellation/chargeback rate exceeds **0.5%**. |
| **Polar.sh** (`polar.sh`) | **PROHIBITED** (Item #2) | **PROHIBITED** (Item #2) | **PROHIBITED** (Items #4, #7) | [Polar Acceptable Use Policy](https://docs.polar.sh/merchant-of-record/acceptable-use): Restricted strictly to SaaS and digital software/content. Explicitly prohibits **Human services** and **Marketplaces / third-party seller payouts**. |
| **Lemon Squeezy** (`lemonsqueezy.com`) | **PROHIBITED** | **PROHIBITED** | **PROHIBITED** | Acquired by Stripe (July 2024). Prohibits human consulting/freelance services and third-party marketplace reselling; ~6.5%–8.5% effective cost. |
| **Paddle** (`paddle.com`) | **PROHIBITED** | **PROHIBITED** | **PROHIBITED** | B2B/B2C software & SaaS only; human consulting and marketplaces are rejected during domain underwriting. |
| **Creem** (`creem.io`) | **PROHIBITED** | **PROHIBITED** | **PROHIBITED** | Prohibits consulting, freelancing, mentoring, tutoring, and multi-seller marketplaces. |

### 3.2 Structural Reasons MoRs Cannot Power a Two-Sided Marketplace
1. **No Consultant Split or Payout API**: MoRs act as legal resellers of first-party software and remit a single net payout to **one** merchant bank account (monthly/bi-weekly). They have no equivalent to `RazorpayX Payouts`, `Cashfree Payouts`, or `Stripe Connect`.
2. **100% Revenue Inflation & Tax Mismatch**: An MoR issues a self-billed B2B invoice to Familiarise for 100% of gross sales (minus MoR fee), forcing Familiarise to book 100% of marketplace GMV as first-party export revenue rather than an agency/marketplace split, and providing no mechanism for Indian Section 393 / 194-O TDS withholding.
3. **High Fees**: Dodo Payments charges **4.0% + \$0.40 base + 0.5% subscription + 1.0% international + FX + wire fees (~5.5%–7% effective)** and discontinued its native INR wallet in 2026.

> **Narrow Exception**: See [`mor-guardrails/README.md`](./mor-guardrails/README.md) — `DODO_PAYMENTS` or `Polar.sh` may **only** be considered if Familiarise launches a separate, 100% automated first-party SaaS or pre-recorded digital product SKU with zero human coaching and zero third-party consultant payouts.

---

## 4. Detailed Comparison of Approved / Viable Gateways

| Feature | **Razorpay + RazorpayX** (Live Primary) | **Cashfree PG + Payouts v2** (#1 Full-Stack Backup) | **Tazapay** (#1 Global Pay-in + Foreign Consultant Payouts) | **Xflow** (#1 High-Ticket \$500+ & B2B Export) |
|---|---|---|---|---|
| **RBI License** | Final **PA-O + PA-P + PA-CB** (Dec 2, 2025) | Final **PA + PA-CB (Export & Import)** (July 2024) | MAS MPI (SG) + FinCEN/FINTRAC + India PA-CB partner (Cashfree) | Final **PA-CB** (backed by Stripe; Stripe + JPMorgan rails) |
| **1:1 Consulting & Marketplaces Allowed?** | **Yes** | **Yes** | **Yes** (explicitly supports consulting, edtech & marketplaces) | **Yes** (B2B & cross-border services export) |
| **Domestic India Pay-ins** | UPI: **0%**; Cards/NB: **2.0% + GST** | UPI: **0%**; Cards/NB: **1.95% + GST** | UPI & Indian Cards supported | N/A (Cross-border export only) |
| **International Pay-ins** | Cards (160+ currencies): **~3.0% + GST**<br>Apple Pay (70+ countries): **0% extra**<br>PayPal<br>MoneySaver (ACH/SEPA/FPS): **1% + 0% FX** | Cards (140+ currencies) + DCC + PayPal: **2.99% + GST** | **80+ Local Rails** (US ACH, EU SEPA, UK FPS, Pix, PayNow: **0.8%–2.5%**) + Cards (**3.8% + \$0.50**) | Local USD ACH/Fedwire, EUR SEPA, GBP FPS + Stripe Cards: **0.4%–0.6% + 0% FX markup** (\$12 min on Starter ≤ \$2k) |
| **INR Settlement & e-FIRA** | T+2 domestic, T+7 intl cards (T+1 MoneySaver/PayPal); auto **FIRS / e-FIRA** | T+2 domestic, T+2–T+5 intl; auto **e-FIRA** | T+1–T+2 INR settlement with **1-day automated e-FIRA** | **Next-business-day** INR settlement with **24-hour automated e-FIRA** |
| **Indian Consultant Payouts** | **RazorpayX Payouts** (`IMPS`/`UPI`/`NEFT`/`RTGS`) + Penny Drop & Reverse Penny Drop (`upi_intent`) | **Cashfree Payouts v2** (`IMPS`/`UPI`/`NEFT`) + **Secure ID** Penny Drop & Reverse Penny Drop + **Easy Split** (`0.1%–0.2%`) | Settles INR to Indian bank account (disbursed via RazorpayX / Cashfree Payouts) | Settles INR to Indian bank account (disbursed via RazorpayX / Cashfree Payouts) |
| **Foreign (Non-Indian) Consultant Payouts** | Not supported (RazorpayX is INR-only) | Outbound import PA-CB only | **Supported in 70+ countries (`POST /v3/payout`, \$2–\$5 local rail fee)** from multi-currency USD/EUR/GBP balance — **avoids double-FX (`4%–6%`) and Indian Sec 393 / Forms 145 & 146 (pre-cutover Sec 195 / Forms 15CA & 15CB) friction!** | Inward export collection only |
| **Guide Link** | [`razorpay/06-international-payments-and-moneysaver.md`](./razorpay/06-international-payments-and-moneysaver.md) | [`cashfree/README.md`](./cashfree/README.md) | [`tazapay/README.md`](./tazapay/README.md) | [`xflow/README.md`](./xflow/README.md) |

---

## 5. Related Documentation

- [Payment Gateways Overview](./README.md)
- [Razorpay International Payments & MoneySaver](./razorpay/06-international-payments-and-moneysaver.md)
- [Cashfree Payments & Payouts v2 Reference](./cashfree/README.md)
- [Tazapay Cross-Border & Foreign Consultant Payouts Reference](./tazapay/README.md)
- [Xflow High-Ticket & B2B Export Reference](./xflow/README.md)
- [Merchant of Record (Dodo Payments & Polar) AUP Guardrails](./mor-guardrails/README.md)
