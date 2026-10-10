# Webhook Behavior During Maintenance & Degraded Operations

## Overview

All inbound webhook receivers (`/api/webhooks/*`) are **strictly exempt from edge maintenance mode (`DEGRADED` and `OFFLINE`)**. Payment confirmations, banking reversals, video recording completions, email bounce/complaint suppressions, and notification outbox updates continue ingesting even when interactive user routes are paused.

---

## 1. Provider Delivery Semantics, Timeouts & Failure Modes

| Provider                 | Route                         | Signature Verification                                                                                                                                                    | Timeout & Vendor Retry Window                                                                           | DB Outage / Migration Response                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Razorpay & RazorpayX** | `POST /api/webhooks/razorpay` | `x-razorpay-signature` (`HMAC-SHA256` hex); `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, and `RAZORPAYX_WEBHOOK_SECRET` (`payout.*` & `fund_account.*`) | **5 s** timeout; exponential backoff for **24 hours**, then **auto-disables endpoint**                  | Pre-flight `isDbHealthy()` returns **HTTP `503`** so Razorpay retries without counting as a permanent client error.                                                                                                                                                                                                         |
| **Stream Video & Chat**  | `POST /api/stream/webhooks`   | `X-Signature` (`HMAC-SHA256` over **uncompressed UTF-8 body** even when gzip-compressed `>256B`) + `X-Api-Key` check                                                      | **6 s** timeout per attempt, **0 ms** backoff, up to **5 attempts** inside **15 seconds total**         | Returns **HTTP `503`** when `recordStreamEventReceipt` fails to persist the receipt before acknowledgement; because Stream's entire retry budget expires in **15 seconds**, `transfer-recordings`, `auto-complete-appointments`, and `reconcile-orphaned-confirmations` heal missed call/recording events via REST polling. |
| **Resend**               | `POST /api/webhooks/resend`   | Svix Standard Webhooks (`svix-id`, `svix-timestamp`, `svix-signature`, `whsec_` secret, **5-minute** timestamp replay window)                                             | Svix exponential backoff across multiple days                                                           | Single atomic `$transaction(tx)` writes `EmailEvent` + suppression/waitlist/contact/domain mutations; any DB error rolls back and returns **HTTP `500`** so Svix retries cleanly.                                                                                                                                           |
| **Novu**                 | `POST /api/webhooks/novu`     | Svix Standard Webhooks (`svix-id`, `svix-timestamp`, `svix-signature`, **5-minute** tolerance) with channel `x-novu-signature` HMAC fallback                              | **15 s** timeout; 8 attempts (`0s, 5s, 5m, 30m, 2h, 5h, 10h, +10h`) over **5 days** before auto-disable | Pre-flight `isDbHealthy()` returns **HTTP `503`**; in-flight DB errors record onto `WebhookEvent` for `sweep-stuck-webhook-events`.                                                                                                                                                                                         |
| **Stripe**               | `POST /api/webhooks/stripe`   | `stripe-signature` via `stripe.webhooks.constructEvent()`                                                                                                                 | **20 s** timeout; exponential backoff up to **3 days** (~15 attempts)                                   | Returns **HTTP `500`/`503`** on DB unavailability so Stripe retries.                                                                                                                                                                                                                                                        |

---

## 2. Provider-Specific Payload & Protocol Nuances

### Stream Video & Chat (`POST /api/stream/webhooks`)

- **Compression & Signature Order**: Stream compresses webhook payloads larger than 256 bytes using gzip, but **`X-Signature` is always computed over the uncompressed UTF-8 JSON bytes**. Decompress first, verify `X-Signature` against the uncompressed UTF-8 payload + `X-Api-Key`, then deduplicate via `X-Webhook-Id`.
- **V2 `event_hooks` Configuration**: Stream V2 `event_hooks` treat both `event_types: []` and `event_types: ["*"]` as wildcard unfiltered subscriptions; `ensure-webhook-subscription.ts` enforces exact set equality against `DESIRED_EVENT_TYPES` (`product: "video"`).
- **Handled Events**: `call.recording_started`, `call.recording_stopped`, `call.recording_ready`, `call.recording_failed`, `call.session_participant_joined`, `call.session_participant_left`, `call.session_ended`, and `call.ended` (extracting `user.id` and `reason` for call termination auditing).

### Resend (`POST /api/webhooks/resend`)

- Executes `EmailEvent` creation (`@unique` on `svixId`) and recipient side effects inside **one atomic Prisma `$transaction(tx)`** under `PG_POOL_MAX=1`:
  - `email.bounced` (`Permanent`), `email.complained`, `email.suppressed`: upserts `EmailSuppression` and marks `Waitlist` (`BOUNCED` / `UNSUBSCRIBED`).
  - `contact.deleted` & `contact.updated` (when `unsubscribed === true`): suppresses the recipient and marks `Waitlist` (`UNSUBSCRIBED`).
  - `domain.updated` / `domain.deleted`: calls `recordSystemErrorSafe` after transaction commit if sending domain DNS verification degrades (`failed` / `not_started`) or is deleted.

### Novu (`POST /api/webhooks/novu`)

- Supports both Novu platform Svix outbound webhooks (`svix-id`, `svix-timestamp`, `svix-signature` + nested `data.object.{subscriberId, channel, transactionId, status, error}` envelope) and legacy workflow channel HMAC signatures (`x-novu-signature` / `novu-signature`), advancing `NotificationOutbox` (`PENDING -> SENT` or stamping `lastError`).

---

## 3. Serverless Freeze Recovery & Schema Migration Discipline

1. **Netlify `after()` Container Freeze Recovery (`sweep-stuck-webhook-events`)**:
   - Because Razorpay (`5s`) and Stream (`6s`) require immediate `200 OK` responses before running domain logic inside Next.js `after()`, a serverless cold freeze or deployment rollout mid-callback leaves `WebhookEvent` rows in `processed = false, error = null`.
   - Every 15 minutes on the Netlify ticker (`scripts/cleanup/sweep-stuck-webhook-events.ts`), stale rows (>6 minutes old across `"razorpay"`, `"stream"`, and `"novu"`) are reclaimed via CAS lease fencing (`WebhookClaim` on `claimedAt`) and re-driven inside a per-event execution timeout.
2. **Zero-Downtime Schema Migrations (`PG_POOL_MAX=1`)**:
   - Keep maintenance windows **under 15 minutes** so Razorpay (24h window), Novu (5d window), Resend, and Stripe never hit endpoint auto-disable thresholds.
   - Always apply additive expand-and-contract DDL changes on `WebhookEvent`, `Payment`, `Refund`, `Dispute`, `EmailEvent`, and `Payout` tables; never acquire long-running `ACCESS EXCLUSIVE` locks that would stall `isDbHealthy()` past Razorpay's 5-second timeout.
   - Run `reconcile-payment-status`, `reconcile-pending-refunds`, `reconcile-disputes`, and `reconcile-payout-status` immediately after concluding any maintenance window.
3. **Weekly Multi-Table Retention (`archive-webhook-events`)**:
   - Prunes processed `WebhookEvent` rows, terminal unprocessed `WebhookEvent` rows (`processed = false` with `permanent:` / `gave up:` error), and terminal `OutboundWebhookDelivery` rows after **30 days**, and prunes non-terminal failed `WebhookEvent` rows plus `EmailEvent` rows after **90 days** every Sunday UTC midnight.

---

## Deprecated & Superseded Approaches

- **Uncompressed-Assumption Parsing Without Gzip Support**: Superseded by `POST /api/stream/webhooks` decompressing gzip payloads before verifying `X-Signature` over raw UTF-8 text and deduplicating on `X-Webhook-Id`.
- **Non-Atomic Resend Webhook Writes**: Superseded by single-transaction `EmailEvent` + `EmailSuppression` + `Waitlist` commits so database blips during maintenance return HTTP `500` instead of losing bounce suppressions.
- **Channel-Only `x-novu-signature` Parsing on Novu Webhooks**: Superseded by dual Svix + HMAC verification and nested `data.object.*` envelope extraction plus `sweep-stuck-webhook-events` coverage.
