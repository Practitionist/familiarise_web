# Webhook Architecture Overview

> **Scope:** Gateway-wide inbound verification, deduplication, asynchronous execution under `PG_POOL_MAX=1`, stuck-event sweeping, and retention archival across all external webhook providers. Organization-specific double-entry ledger semantics live in [`docs/enterprise/10-money-and-ledger/12-payment-webhooks.md`](../../enterprise/10-money-and-ledger/12-payment-webhooks.md), Stream recording pipelines live in [`docs/stream/13-recording-webhooks.md`](../../stream/13-recording-webhooks.md), and tenant outbound webhooks live in [`docs/enterprise/40-compliance-and-data/04-outbound-webhooks.md`](../../enterprise/40-compliance-and-data/04-outbound-webhooks.md).

---

## 1. Multi-Provider Webhook Matrix

Every inbound webhook receiver runs on the Node.js App Router runtime (`export const runtime = "nodejs"`), enforces strict byte-length caps via `readBodyWithinCap` before buffering memory, verifies cryptographic signatures against raw UTF-8 request bytes, and deduplicates events against Postgres before executing domain mutations.

| Provider                 | Endpoint                      | Signature & Replay Protocol                                                                                                                                                                                         | Vendor Timeout & Retry Schedule                                                            | Deduplication Key                                                                                                                               | Execution & Recovery Path                                                                                                                      |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Razorpay & RazorpayX** | `POST /api/webhooks/razorpay` | `x-razorpay-signature` (`HMAC-SHA256` hex over raw body); supports `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, and `RAZORPAYX_WEBHOOK_SECRET` (scoped strictly to `payout.*` & `fund_account.*`) | **5 s** timeout; exponential backoff over **24 hours**, then auto-disables endpoint        | `${eventType}:${entityId}:${sha256(rawBody).slice(0, 16)}` on `WebhookEvent.eventId`                                                            | Fast `200 OK` + Next.js `after()` → `processRazorpayWebhookEvent`; recovered via `sweep-stuck-webhook-events`                                  |
| **Stream Video & Chat**  | `POST /api/stream/webhooks`   | `X-Signature` (`HMAC-SHA256` over **uncompressed UTF-8 body** even when gzip-compressed) + `X-Api-Key` verification                                                                                                 | **6 s** per attempt, **0 ms** backoff, up to **5 attempts** inside a **15 s** total window | `X-Webhook-Id` header on `WebhookEvent.eventId`                                                                                                 | Fast `200 OK` + Next.js `after()` → `processStreamEvent`; recovered via `sweep-stuck-webhook-events`                                           |
| **Resend**               | `POST /api/webhooks/resend`   | Svix Standard Webhooks (`svix-id`, `svix-timestamp`, `svix-signature`, `whsec_` secret, **5-minute** timestamp replay window)                                                                                       | Svix exponential backoff across multiple days                                              | `svix-id` on `EmailEvent.svixId` (`@unique`)                                                                                                    | Synchronous single atomic `$transaction(tx)` writing `EmailEvent` + suppression/waitlist/domain effects; `500` on DB error triggers Svix retry |
| **Novu**                 | `POST /api/webhooks/novu`     | Svix Standard Webhooks (`svix-id`, `svix-timestamp`, `svix-signature`, **5-minute** tolerance) with channel `x-novu-signature` HMAC fallback                                                                        | **15 s** timeout; 8 attempts over **5 days** before auto-disable                           | `svix-id` (when `svix-signature` present) `?? event.id ?? event.eventId ?? ${eventType}:${transactionId}:${bodyHash}` on `WebhookEvent.eventId` | Synchronous execution updating `NotificationOutbox` via nested `data.object.*` fields; covered by `sweep-stuck-webhook-events`                 |
| **Stripe**               | `POST /api/webhooks/stripe`   | `stripe-signature` via `stripe.webhooks.constructEvent()`                                                                                                                                                           | **20 s** timeout; exponential backoff up to **3 days**                                     | Gateway `event.id` on `WebhookEvent.eventId`                                                                                                    | Synchronous idempotency check + domain dispatch                                                                                                |

---

## 2. Distributed Systems & Serverless Invariants

1. **`PG_POOL_MAX=1` Single-Connection Discipline**:
   - Serverless function instances operate with a 1-connection pool. Inside any `prisma.$transaction(async (tx) => ...)`, every domain helper, CAS state transition, and ledger entry passes `tx` explicitly — never the global `prisma` client, which deadlocks waiting for the single checked-out connection.
2. **Netlify `after()` Container Freeze Recovery & CAS Claim Fencing**:
   - Razorpay (5 s timeout) and Stream (6 s timeout) require acknowledging HTTP `200` immediately after persisting `WebhookEvent` (`processed: false`) and delegating business logic to Next.js `after()`.
   - If the serverless container freezes or crashes mid-`after()`, `sweep-stuck-webhook-events` (`scripts/cleanup/sweep-stuck-webhook-events.ts`, registered in `lib/cron/cleanup-registry.ts`) re-drives stuck/failed rows (`razorpay`, `stream`, and `novu`) under CAS lease fencing (`WebhookClaim` on `claimedAt`) with a strict **per-event timeout** so a single slow row never blocks the sweep batch.
3. **Out-of-Order `DeferSignal` vs. Permanent Failures**:
   - Valid webhooks whose parent records have not yet committed (e.g., `refund.created` arriving before `payment.captured`, or `payment.dispute.won` before `payment.dispute.created`) return `DeferSignal`, incrementing `WebhookEvent.deferCount` while leaving `processed = false, error = null` for clean re-drive (up to `168h` give-up cap).
   - Structural Zod validation mismatches record `permanent: schema mismatch: ...` (`TERMINAL_ERROR_PREFIXES`) and never re-run.
4. **Weekly Multi-Table Retention Archival (`archive-webhook-events`)**:
   - `scripts/cleanup/archive-webhook-events.ts` purges processed `WebhookEvent` rows (>30 days), terminal unprocessed `WebhookEvent` rows (`TERMINAL_ERROR_PREFIXES` >30 days), non-terminal failed/errored `WebhookEvent` rows (>90 days), aged `EmailEvent` records (>90 days), and terminal (`SUCCESS` / `FAILED` / `DEAD_LETTER`) `OutboundWebhookDelivery` rows (>30 days) every Sunday UTC midnight.

---

## 3. Documents in This Directory

| #   | Document                                                               | Description                                                                                                                                             |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | [Monitoring & Operations](./01-monitoring.md)                          | Webhook observability, `WebhookEvent` state machine inspection, `DeferSignal` & `sweep-stuck-webhook-events` runbook, and weekly retention archival     |
| 02  | [Razorpay & RazorpayX Webhook Schema](./02-razorpay-webhook-schema.md) | Complete Razorpay & RazorpayX schema reference, tamper-proof `eventId` derivation, PHP `notes: []` normalization, and multi-attempt checkout guarantees |

---

## Deprecated & Superseded Approaches

- **Keying Razorpay Idempotency on Unsigned `x-razorpay-event-id` or Plain `${eventType}:${entityId}`**: Superseded by `${eventType}:${entityId}:${sha256(rawBody).slice(0, 16)}` to prevent both unsigned header replay attacks and false duplicate drops on multi-stage `payout.updated` / `payment.dispute.*` updates.
- **Unfenced Asynchronous `after()` Completion Writes**: Superseded by conditional CAS fencing on `WebhookEvent.claimedAt` (`WebhookClaim`) so a delayed or unfreezing container cannot overwrite a sweeper worker's completion status.
- **Separate Non-Transactional `EmailEvent` Insert Before Resend Side Effects**: Superseded by wrapping `EmailEvent.create` + `EmailSuppression` + `Waitlist` updates inside a single `$transaction(tx)` so transient DB errors return HTTP `500` instead of silently skipping suppressions.
