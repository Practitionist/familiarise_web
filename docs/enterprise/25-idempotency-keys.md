# 25 — Idempotency keys & deterministic IDs

Every endpoint that triggers side effects — payments, webhooks, emails,
ledger mutations — has to survive a duplicate call without double-
charging a customer, double-crediting a wallet, or double-sending a
notification. This document is the authoritative map of **what key we
use where, and why**.

---

## Why idempotency matters here

- Razorpay and Stripe both retry webhooks on 5xx for up to 24h.
  Without deduplication, a transient 500 would process the same
  `payment.captured` twice and credit the wallet twice.
- The subscription cron can be triggered by GitHub Actions, a
  human operator running `npx tsx`, and (eventually) a worker queue
  simultaneously. Without an atomic claim, two workers race and
  create two invoices with the same `invoiceNumber`.
- Clients retry on network errors. A wallet top-up POST that
  succeeds on the server but fails to return to the client will be
  retried — we can't create two orders and two rows.

The rule: **every side-effect entry point has an idempotency key**.

---

## Key catalogue

### Webhooks

| Source | Key | Storage | Lifetime |
|--------|-----|---------|----------|
| Razorpay | `event.id` (vendor-assigned) | `WebhookEvent.id` | Permanent |
| Razorpay fallback | `sha256(raw_body)` when `event.id` missing | `WebhookEvent.id` | Permanent |
| Stripe | `event.id` (vendor-assigned) | `WebhookEvent.id` | Permanent |
| Stripe fallback | `sha256(raw_body)` | `WebhookEvent.id` | Permanent |

**Why deterministic fallback?** Earlier the fallback was
`Date.now() + Math.random()`, which means replaying the same payload
produced a brand-new `WebhookEvent` row every time — defeating the
point. Hashing the body makes replays truly idempotent.

See `app/api/webhooks/razorpay/route.ts` and
`app/api/webhooks/stripe/route.ts`.

### Payment orders

| Operation | Key | Collision handling |
|-----------|-----|--------------------|
| Wallet top-up | `razorpay_order_id` (mint on `create-order`) | `P2002` on `WalletEntry.razorpayOrderId` unique |
| Invoice payment | `razorpay_order_id` | `P2002` on `OrganizationInvoice.providerPaymentOrderId` unique |
| One-time subscription checkout | `razorpay_order_id` | same |
| Day-pass | `razorpay_order_id` | same |

The client always hands back the same `razorpay_order_id` it received
— the server never accepts a client-supplied idempotency key because
that opens a replay-attack vector.

### Invoices

| Source | Key | Storage |
|--------|-----|---------|
| Subscription cron | `subscriptionId + billingCycleIndex` computed into `invoiceNumber` | `OrganizationInvoice.invoiceNumber` unique |
| Manual generation | `organizationId + yyyymm + sequence` | same |

The subscription cron's atomic claim (`updateMany` with
`nextInvoiceDate: { lte: now }`) prevents duplicate invocations from
generating two invoices for the same cycle. Even if two workers
happen to pass the claim, the `invoiceNumber` unique constraint will
reject the second insert with `P2002`, which the cron catches and
logs as `subs.invoice.skipped`.

### Payment legs

| Source | Key | Storage |
|--------|-----|---------|
| `CARD` source | `gatewayPaymentId` (from the captured Razorpay/Stripe payment) | `PaymentLeg.sourceRef` |
| `REFERRAL_CREDIT` | `referralCreditUsageId` (mint inside the same TX that debits the credit) | same |
| `WALLET`/`INVOICE_ACCRUAL`/`LICENSE` | `programAssignmentId` | same |

See `lib/payments/payment-legs.ts` for the typed builder that enforces
the correct key-to-source pairing at compile time.

### Refunds

| Source | Key | Storage |
|--------|-----|---------|
| Razorpay `refund.created` webhook | `refund.id` | `WalletEntry.razorpayRefundId` unique, with `P2002` resilience for concurrent workers |

### Ledger reconciliation

| Source | Key |
|--------|-----|
| Scheduled cron | `runAt` timestamp (not strictly an idempotency key — duplicate runs are safe because they're read-only) |
| Admin-triggered | same; a concurrent POST will just produce two reports, both safe |

### Emails (Resend)

| Source | Key |
|--------|-----|
| MSME payout alert | `orgId + mustPayByDate` (hashed into a `X-Entity-Ref-ID` header) |
| Invoice receipt | `invoiceId` |
| SSO activation | `organizationId + ssoProviderId` |

Resend will deduplicate on `X-Entity-Ref-ID` automatically; our code
doesn't have to manually check a "sent emails" table.

---

## Anti-patterns

### ❌ Client-supplied idempotency keys for money operations

Letting the client pass `Idempotency-Key: <their-uuid>` means a
malicious client can choose a collision and force the server to
return a previously-successful response — effectively a replay
attack. The server must **always derive the key from immutable
request content** (body hash, captured payment id, etc.).

### ❌ `Date.now() + Math.random()` as a fallback

This is the pattern we explicitly removed from the webhook
handlers. Non-deterministic keys mean replays aren't deduplicated,
and the only way to find the "real" row is a full table scan.

### ❌ Putting idempotency keys in the URL path

Caches, proxies, and Next.js's CDN layer may dedupe on URL paths.
The key belongs in the request body (or the
`Idempotency-Key` header, but see the first bullet).

### ❌ Assuming two rows can be "merged later"

Duplicate `WalletEntry` rows, even with the same `deltaPaise`, are a
data bug. Both rows would be counted toward the wallet balance,
because the balance is a sum of deltas. Reject the duplicate at
write time with `P2002`; don't try to merge after the fact.

---

## Testing idempotency

Every payment-touching code path has a test that:

1. Runs the happy path end-to-end.
2. Retries the same request with the same body/signature.
3. Asserts **zero** additional DB mutations occurred.

The pattern:

```ts
it("is idempotent on replay", async () => {
  const before = await prisma.walletEntry.count();
  await handler(req);
  const afterFirst = await prisma.walletEntry.count();

  await handler(req); // same req, same signature
  const afterSecond = await prisma.walletEntry.count();

  expect(afterFirst - before).toBe(1);
  expect(afterSecond - afterFirst).toBe(0); // no new row
});
```

If you're touching a new side-effect endpoint, add this test first.
