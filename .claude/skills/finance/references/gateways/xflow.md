# Xflow (`XFLOW`) High-Ticket ($500+) & B2B Export Collection Reference

**Role in Familiarise**: **High-Ticket (`>= $500 USD`) International Mentorship Packages & B2B `OrganizationInvoice` Export Collection Rail**.
**Official Docs**: `https://docs.xflowpay.com/` (Xflow v1 Stripe-style REST API).
**Architecture Guide**: [`docs/payments/gateways/xflow/README.md`](../../../../docs/payments/gateways/xflow/README.md).

---

## 1. Why & When to Route Through Xflow (`>= $500` Only)

Xflow is an institutional cross-border payment platform built for Indian service/SaaS exporters in partnership with **Stripe** and **JPMorgan Chase N.A.** (regulated in the US under FinCEN MSB, in Canada under FINTRAC, and in India under RBI's PA-CB framework).

| Parameter | Xflow (`XFLOW`) | Razorpay International Cards |
| --- | --- | --- |
| **Platform Fee** | **`0.4%–0.6%` tiered** (`1.0%` Starter with **`$12` minimum fee**) | `~3.0%–4.3%` + 18% GST |
| **FX Conversion Rate** | **`0% FX markup`** over live mid-market Google rate | `~2.0%–3.0%` hidden FX spread |
| **Net Cost on `$2,000` Invoice** | **`$12` (`0.6%` total)** | **`~$110–$125` (`~5.5%–6.2%` total)** |
| **Net Cost on `$50` 1:1 Session** | `$12` (`24%` effective due to `$12` floor!) | `~$2.75` (`~5.5%` total) |
| **Receiving Rails** | Local **US ACH / Fedwire** (`JPMorgan Chase`), **EU SEPA**, **UK FPS**, **CAD EFT**, **SWIFT**, plus **Hosted Payment Links** | Cards, Apple Pay, PayPal, MoneySaver IBT |
| **Export Proof (`e-FIRA`)** | **Automated within 24 hours** of INR settlement (free) | Automated FIRS in Dashboard |

**Routing Rule**:
- **DO route through Xflow**: B2B `OrganizationInvoice` exports and high-ticket international mentorship/cohort packages (`>= $500 USD` / `EUR` / `GBP`).
- **DO NOT route through Xflow**: Low-ticket (`< $300 USD`) B2C 1:1 consultations or single webinar tickets, because Xflow's `$12` Starter minimum fee makes small transactions uneconomical.

---

## 2. Xflow v1 API Reference

- **Base URL**: `https://api.xflowpay.com/v1`
- **Authentication**: `Authorization: Bearer <XFLOW_SECRET_KEY>`
- **Idempotency**: `Idempotency-Key: <UUID>` on all `POST` requests.
- **Monetary Units**: Decimal string major units (e.g., `"2500.00"` for `$2,500.00 USD`). Convert from our `BigInt` subunits (`(Number(amountSubunits) / 100).toFixed(2)`) at the adapter boundary only.

### 2.1 Create Buyer Account (`POST /v1/accounts`)
```json
{
  "type": "partner",
  "business_details": {
    "legal_name": "Acme Global Learning Inc.",
    "physical_address": {
      "line1": "548 Market St",
      "city": "San Francisco",
      "state": "CA",
      "postal_code": "94104",
      "country": "US"
    }
  },
  "contact_details": {
    "email": "ap@acmeglobal.example.com"
  }
}
```
- Returns `account_...`.

### 2.2 Create Receivable with Export Invoice & Purpose Code (`POST /v1/receivables`)
Every cross-border inflow into India under FEMA requires an underlying export invoice and RBI Purpose Code (`P1007` Management/business consultancy, `P0802` IT/software consultancy, or `P1107` Educational services):
```json
{
  "account_id": "account_clx123456",
  "amount_maximum_reconcilable": "2500.00",
  "currency": "USD",
  "description": "Familiarise Enterprise Mentorship Cohort (10 Seats)",
  "invoice": {
    "amount": "2500.00",
    "currency": "USD",
    "creation_date": "2026-10-05",
    "due_date": "2026-10-20",
    "document": "file_xflow_invoice_pdf_123",
    "reference_number": "FAM-ORG-2026-0089"
  },
  "purpose_code": "P1007",
  "transaction_type": "services",
  "metadata": {
    "organizationInvoiceId": "org_inv_01J9X555",
    "paymentId": "pay_01J9X666"
  }
}
```
- **Confirm Receivable**: Call `POST /v1/receivables/{id}/confirm` to activate reconciliation against virtual bank inflows or generate a Hosted Payment Link (`POST /v1/payment_links`).

---

## 3. Webhook Verification (`Xflow-Signature`) & Event Mapping

Xflow uses Stripe-style timestamped HMAC-SHA256 signatures in the `Xflow-Signature` header (`t=<unix_seconds>,v1=<hex_hmac>`).

```typescript
import crypto from "crypto";

export function verifyXflowWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300
): boolean {
  if (!rawBody || !signatureHeader || !webhookSecret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [k, v] = part.split("=");
      return [k?.trim(), v?.trim()];
    })
  );
  const timestamp = parts.t;
  const receivedHex = parts.v1;
  if (!timestamp || !receivedHex) return false;

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (Number.isNaN(ageSeconds) || ageSeconds > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedHex = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expectedHex, "utf8");
  const receivedBuf = Buffer.from(receivedHex, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
```

### Event Mapping (`app/api/webhooks/xflow/route.ts`)
| Xflow Event `type` | Internal Handler Action |
| --- | --- |
| `receivable.reconciled` | Route through single-writer `handlePaymentSuccess` / `markOrganizationInvoicePaid` inside a `Serializable` `$transaction` |
| `deposit.credited` | Record incoming foreign currency deposit arrival against virtual account |
| `payout.settled` | Record settled INR amount (`settled_amount_inr`), FX rate, and attach the 24h **e-FIRA** PDF (`payout.fira_file_id`) to `OrganizationInvoice` / `Invoice` |
| `payout.failed` | Alert finance ops for compliance/FIRA document remediation |
