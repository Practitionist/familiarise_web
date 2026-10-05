# Xflow High-Ticket International & B2B Export Collection (`XFLOW`)

> **Status**: Planned High-Ticket International (\$500+) & B2B Enterprise Invoice Rail
> **Last Updated**: 2026-10-05
> **Official Citations**:
> - [Xflow Developer Documentation (`https://docs.xflowpay.com`)](https://docs.xflowpay.com/)
> - [Xflow Pricing & FX Transparency](https://www.xflowpay.com/pricing)
> - [Xflow RBI PA-CB Authorization & e-FIRA](https://www.xflowpay.com/)

---

## 1. Overview & Why Xflow Complements Razorpay

**Xflow (`xflowpay.com`)** was founded by former Stripe India head Anand Balaji, is backed by **Stripe, PayPal Ventures, and General Catalyst**, holds a **final RBI Payment Aggregator – Cross Border (PA-CB)** license, and runs directly on **Stripe + JPMorgan Chase** global payment infrastructure.

In March 2026, Xflow was set aside for small B2C impulse bookings (`< $100`) because its Starter tier has a **$12 minimum fee** on transactions under $2,000. However, for **high-ticket mentorship packages ($500–$5,000), cohort bootcamps, and B2B `OrganizationInvoice` collections**, Xflow is the lowest-cost, highest-reliability cross-border rail available to an Indian company:

### Cost Comparison on a \$2,000 Mentorship Package or B2B Org Invoice

| Gateway | Base Fee | FX Markup (vs Mid-Market) | Total Cost on \$2,000 | e-FIRA Speed |
|---|---|---|---|---|
| **Razorpay International Cards** | 3.0% + 18% GST (\$70.80) | ~1.0%–2.0% (\$20–\$40) | **~\$90–\$110 (~4.5%–5.5%)** | Per settlement cycle (T+7) |
| **Tazapay Cards** | 3.8% + \$0.50 (\$76.50) | ~1.5% (\$30) | **~\$106.50 (~5.3%)** | 1 business day |
| **Xflow (Local USD ACH / EUR SEPA / GBP FPS)** | **0.6%** (**\$12.00**) | **0.00% (Live Mid-Market Rate)** | **\$12.00 (0.60% all-in!)** | **Within 24 hours of settlement** |

---

## 2. Where Xflow Fits in Familiarise

| Flow | How Xflow Is Used |
|---|---|
| **1. B2B Enterprise Invoices (`OrganizationInvoice`)** | When an international client organization funds a prepaid wallet or settles a post-paid `OrganizationInvoice`, Familiarise creates an Xflow `Receivable` (`POST /v1/receivables`) linked to the invoice PDF and shares the virtual **USD (JPMorgan ACH/Fedwire)**, **EUR (SEPA)**, **GBP (FPS)**, **CAD**, or **AUD** bank details or Stripe-powered Xflow Payment Link. |
| **2. High-Ticket B2C Mentorship / Cohort Packages (`>= $500`)** | Checkout offers **"Pay via US/EU/UK Bank Transfer (0% FX fee)"** or Xflow's Stripe-powered Checkout Link alongside Razorpay International Cards. |
| **3. Automated FEMA / GST LUT Compliance** | Every Xflow settlement into Familiarise's Indian current account automatically mints an AD Category-I Bank **e-FIRA PDF within 24 hours**, downloadable via API (`GET /v1/payouts/:id/fira`) and attachable directly to our `Invoice` / `OrganizationInvoice` export compliance record. |

---

## 3. Core Xflow REST API (`https://api.xflowpay.com/v1`)

Xflow's API design is modeled directly after Stripe's REST API (built by ex-Stripe engineers):

| Object / Endpoint | Purpose |
|---|---|
| `POST /v1/accounts` | Creates a `client` account representing the foreign buyer/organization. |
| `POST /v1/receivables` | Creates a FEMA-compliant export receivable (`amount`, `currency`, `purpose_code: "P1006" \| "P0802"`, `invoice: { reference_number, creation_date, document }`). Must be reconciled against an invoice so the AD Bank can issue the e-FIRA. |
| `POST /v1/payment_links` | Generates a hosted Stripe-powered checkout link for a `Receivable` (supports USD/EUR/GBP/CAD/AUD bank transfers and international cards). |
| `receivable.amount_reconciled.updated`, `deposit.status.completed` & `payout.status.settled` Webhooks | Signed via `Webhook-Id`, `Webhook-Timestamp`, and `Webhook-Signature` headers (Base64 HMAC-SHA256 over `id.timestamp.rawBody`). Signals when foreign currency is collected and reconciled, and when the exact INR settlement (`payout.status.settled`) lands in Familiarise's Indian bank account with the `fira_url`. |

---

## 4. Related References

- **Finance Skill Reference**: [`.claude/skills/finance/references/gateways/xflow.md`](../../../../.claude/skills/finance/references/gateways/xflow.md)
- **Subagent**: [`.claude/agents/xflow-b2b-export.md`](../../../../.claude/agents/xflow-b2b-export.md)
- **Gateway Evaluation (2026)**: [`../gateway-evaluation-2026.md`](../gateway-evaluation-2026.md)
