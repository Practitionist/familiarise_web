# Cashfree Payments (`CASHFREE`) & Cashfree Payouts v2 Reference

**Role in Familiarise**: **#1 Full-Stack Domestic + Cross-Border (PA-CB) Backup** to both **Razorpay Payment Gateway** and **RazorpayX Payouts**.
**Official Docs**: `https://docs.cashfree.com/` (`x-api-version: 2025-01-01`).
**Architecture Guide**: [`docs/payments/gateways/cashfree/README.md`](../../../../docs/payments/gateways/cashfree/README.md).

---

## 1. Why Cashfree is Our #1 Backup to Razorpay + RazorpayX

| Capability | Razorpay / RazorpayX | Cashfree Payments / Payouts v2 |
| --- | --- | --- |
| **RBI Licenses** | Final PA-O + PA-P + PA-CB | Final **PA** (Dec 2023) + **PA-CB Export & Import** (July 2024) |
| **Domestic UPI / RuPay** | `0%` | **`0%`** |
| **Domestic Cards & Netbanking** | `~2.0%` + GST | **`1.60%–1.95%`** + GST |
| **International Cards & PayPal** | `~3.0%–4.3%` + GST | **`3.50%` (`2.99%` promotional)** + GST (30+ currencies + automated e-FIRA) |
| **Marketplace Split** | Razorpay Route (`0.25%`) | **Cashfree Easy Split** (`0.10%–0.20%`) |
| **Instant Consultant Payouts** | RazorpayX (`POST /v1/payouts`) | **Cashfree Payouts v2** (`POST /payout/v1.2/directTransfer`) |
| **Bank & VPA Verification** | `/v1/fund_accounts/validations` | **Cashfree Secure ID** (`/verification/bank-account/sync` & `/verification/upi/reverse-penny-drop`) |

---

## 2. CRITICAL Unit & Signature Differences vs Razorpay

### A. Major Units (Decimal Rupees) at Cashfree Boundary vs `BigInt` Paise in Prisma
- **Razorpay** takes integer subunits (`50000` paise = `₹500.00`).
- **Cashfree PG v5 (`order_amount`, `refund_amount`) and Cashfree Payouts v2 (`amount`) take DECIMAL MAJOR UNITS (`500.00` rupees = `₹500.00`)!**
- **Non-Negotiable Rule**:
  - Prisma (`Payment.amount`, `Refund.amount`, `ConsultantPayout.amount`, `LedgerEntry.amount`) ALWAYS remains **`BigInt` paise**.
  - Convert at the Cashfree adapter boundary only:
    ```typescript
    export function paiseToCashfreeMajorUnits(amountPaise: bigint): number {
      return Number(( Number(amountPaise) / 100 ).toFixed(2));
    }

    export function cashfreeMajorUnitsToPaise(amountMajor: number | string): bigint {
      return BigInt(Math.round(Number(amountMajor) * 100));
    }
    ```

### B. Webhook Signature Formula (`base64`, NOT `hex`, with Timestamp Prefix)
- **Razorpay**: `HMAC_SHA256_HEX(rawBody, RAZORPAY_WEBHOOK_SECRET)`
- **Cashfree**: `HMAC_SHA256_BASE64(xWebhookTimestamp + rawBody, CASHFREE_CLIENT_SECRET)`
  - Headers: `x-webhook-timestamp` (Unix ms string), `x-webhook-signature` (Base64 string), `x-webhook-version` (`2025-01-01`).
  - Always verify with length-guarded `crypto.timingSafeEqual`:
    ```typescript
    import crypto from "crypto";

    export function verifyCashfreeWebhookSignature(
      rawBody: string,
      signature: string,
      timestamp: string,
      secretKey: string
    ): boolean {
      if (!rawBody || !signature || !timestamp || !secretKey) return false;
      const expectedBase64 = crypto
        .createHmac("sha256", secretKey)
        .update(timestamp + rawBody)
        .digest("base64");

      const expectedBuf = Buffer.from(expectedBase64, "utf8");
      const receivedBuf = Buffer.from(signature, "utf8");
      if (expectedBuf.length !== receivedBuf.length) return false;
      return crypto.timingSafeEqual(expectedBuf, receivedBuf);
    }
    ```

---

## 3. Cashfree Payment Gateway (PG v5) Endpoints & SDK

- **NPM Packages**: `cashfree-pg` (server) + `@cashfreepayments/cashfree-js` (browser).
- **Base URLs**:
  - Sandbox: `https://sandbox.cashfree.com/pg`
  - Production: `https://api.cashfree.com/pg`
- **Mandatory Headers**:
  - `x-client-id: process.env.CASHFREE_APP_ID`
  - `x-client-secret: process.env.CASHFREE_SECRET_KEY`
  - `x-api-version: "2025-01-01"`
  - `x-idempotency-key: <UUID>` (on `POST` mutations)

### 3.1 Create Order (`POST /pg/orders`)
```json
{
  "order_id": "fam_ord_01J9X2A3B4C5",
  "order_amount": 2500.00,
  "order_currency": "INR",
  "customer_details": {
    "customer_id": "usr_clx123456",
    "customer_name": "Aarav Sharma",
    "customer_email": "aarav@example.com",
    "customer_phone": "9876543210"
  },
  "order_meta": {
    "return_url": "https://familiarise.com/checkout/verify?order_id={order_id}"
  },
  "order_tags": {
    "appointmentId": "apt_123",
    "consultantProfileId": "con_456"
  }
}
```
- **Limits**: `order_id` max `45` chars (`[a-zA-Z0-9_-]`); `order_tags` max `15` string key-value pairs; returns `cf_order_id` and `payment_session_id`.
- **Frontend Checkout (`@cashfreepayments/cashfree-js`)**:
  ```typescript
  import { load } from "@cashfreepayments/cashfree-js";
  const cashfree = await load({ mode: process.env.NEXT_PUBLIC_CASHFREE_ENV as "sandbox" | "production" });
  await cashfree.checkout({ paymentSessionId, redirectTarget: "_modal" });
  ```
- **Server-Side Payment Verification**: After modal callback, query `GET /pg/orders/{order_id}/payments` (check `payment_status === "SUCCESS"`) OR rely on the `PAYMENT_SUCCESS_WEBHOOK` event through our single-writer confirmation pipeline.

### 3.2 Refunds (`POST /pg/orders/{order_id}/refunds`)
- Follow our **Two-Phase Refund Pattern** (`references/doctrine.md`): reserve a `PENDING` `Refund` row with placeholder `refundId = "pending_<uuid>"` before calling Cashfree.
- Request body:
  ```json
  {
    "refund_id": "fam_ref_01J9X999",
    "refund_amount": 2500.00,
    "refund_note": "Consultation cancelled within refund window",
    "refund_speed": "STANDARD"
  }
  ```
  - `refund_speed`: `"STANDARD"` or `"INSTANT"`.
  - Webhook events: `REFUND_STATUS_WEBHOOK` (`refund_status`: `"SUCCESS"`, `"PENDING"`, `"CANCELLED"`, `"ONHOLD"`).

### 3.3 Webhook Event Mapping (`app/api/webhooks/cashfree/route.ts`)
| Cashfree `type` | Internal Action |
| --- | --- |
| `PAYMENT_SUCCESS_WEBHOOK` | Route through single-writer `handlePaymentSuccess` (`Serializable` `$transaction`, CAS-in-WHERE) |
| `PAYMENT_FAILED_WEBHOOK` / `PAYMENT_USER_DROPPED_WEBHOOK` | Mark `Payment` `FAILED` if still `PENDING` |
| `REFUND_STATUS_WEBHOOK` | Transition `Refund` to `SUCCEEDED` (`SUCCESS`) or `FAILED` (`CANCELLED`, releasing reservation) |
| `DISPUTE_CREATED` / `DISPUTE_UPDATED` / `DISPUTE_CLOSED` | Upsert `Dispute` record & trigger admin alert |
| `SETTLEMENT_SUCCESS` | Update settlement UTR & e-FIRA metadata |

---

## 4. Cashfree Payouts v2 & Secure ID Verification (RazorpayX Backup)

### 4.1 Bank Account & UPI Verification (Cashfree Secure ID)
- **Sync Bank Penny Drop (`POST /verification/bank-account/sync`)**:
  - Verifies `{ bank_account, ifsc, name, phone }` in real time (`account_status: "VALID"` + `name_match_result`).
- **Reverse Penny Drop via UPI Intent (`POST /verification/upi/reverse-penny-drop`)**:
  - Creates a `₹1` UPI Intent verification request (`verification_id`), returning `upi_link` QR/deep-link, and auto-refunds `₹1` while returning the verified `vpa` and `name_at_bank`.

### 4.2 Direct Transfers (`POST /payout/v1.2/directTransfer`)
- Disburses to an existing beneficiary (`beneId`) or inline bank/UPI details:
  - `transferId`: Deterministic idempotency key (`<= 40` alphanumeric/underscore chars) derived from `payout.id`.
  - `amount`: Net post-194-O-TDS payout in **decimal rupees** (`paiseToCashfreeMajorUnits(payout.netAmount)`).
  - `transferMode`: `"upi"` (`<= ₹1,00,000`), `"imps"` (`<= ₹5,00,000`), `"neft"` (no cap), `"rtgs"` (`>= ₹2,00,000`).
- **Payout Webhooks**:
  - `TRANSFER_SUCCESS` -> Mark `ConsultantPayout` `SUCCEEDED`, store `utr`.
  - `TRANSFER_FAILED` / `TRANSFER_REVERSED` / `TRANSFER_REJECTED` -> Mark `FAILED` via CAS-in-WHERE and restore `ConsultantEarnings` to `READY`.
