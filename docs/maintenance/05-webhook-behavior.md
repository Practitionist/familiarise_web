# Webhook Behavior During Maintenance & Degraded Operations

## Overview

All inbound webhook receivers (`/api/webhooks/*`) are **strictly exempt from edge maintenance mode (`DEGRADED` and `OFFLINE`)**. Payment confirmations, banking reversals, video recording completions, and email bounce/complaint suppressions continue ingesting even when interactive user routes are paused.

---

## 1. Provider Delivery Semantics, Timeouts & Failure Modes

| Provider                 | Route                         | Signature Verification                                                                                                                                                    | Timeout & Vendor Retry Window                                                                   | DB Outage / Migration Response                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Razorpay & RazorpayX** | `POST /api/webhooks/razorpay` | `x-razorpay-signature` (`HMAC-SHA256` hex); `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, and `RAZORPAYX_WEBHOOK_SECRET` (`payout.*` & `fund_account.*`) | **5 s** timeout; exponential backoff for **24 hours**, then **auto-disables endpoint**          | Pre-flight `isDbHealthy()` returns **HTTP `503`** so Razorpay retries without counting as a permanent client error.                                                                                                                                                                                                         |
| **Stream Video & Chat**  | `POST /api/stream/webhooks`   | `X-Signature` (`HMAC-SHA256` over **uncompressed UTF-8 body** even when gzip-compressed `>256B`) + `X-Api-Key` check                                                      | **6 s** timeout per attempt, **0 ms** backoff, up to **5 attempts** inside **15 seconds total** | Returns **HTTP `503`** when `recordStreamEventReceipt` fails to persist the receipt before acknowledgement; because Stream's entire retry budget expires in **15 seconds**, `transfer-recordings`, `auto-complete-appointments`, and `reconcile-orphaned-confirmations` heal missed call/recording events via REST polling. |
| **Resend**               | `POST /api/webhooks/resend`   | Svix Standard Webhooks (`svix-id`, `svix-timestamp`, `svix-signature`, `whsec_` secret, **5-minute** timestamp replay window)                                             | Svix exponential backoff across multiple days                                                   | Single atomic `$transaction(tx)` writes `EmailEvent` + suppression/newsletter/consent/contact/domain mutations; any DB error rolls back and returns **HTTP `500`** so Svix retries cleanly.                                                                                                                                 |
| **Stripe**               | `POST /api/webhooks/stripe`   | `stripe-signature` via `stripe.webhooks.constructEvent()`                                                                                                                 | **20 s** timeout; exponential backoff up to **3 days** (~15 attempts)                           | Returns **HTTP `500`/`503`** on DB unavailability so Stripe retries.                                                                                                                                                                                                                                                        |

---

## 2. Provider-Specific Payload & Protocol Nuances

### Stream Video & Chat (`POST /api/stream/webhooks`)

- **Compression & Signature Order**: Stream compresses webhook payloads larger than 256 bytes using gzip, but **`X-Signature` is always computed over the uncompressed UTF-8 JSON bytes**. Decompress first, verify `X-Signature` against the uncompressed UTF-8 payload + `X-Api-Key`, then deduplicate via `X-Webhook-Id`.
- **V2 `event_hooks` Configuration**: Stream V2 `event_hooks` treat both `event_types: []` and `event_types: ["*"]` as wildcard unfiltered subscriptions; `ensure-webhook-subscription.ts` enforces exact set equality against `DESIRED_EVENT_TYPES` (`product: "video"`).
- **Handled Events**: `call.recording_started`, `call.recording_stopped`, `call.recording_ready`, `call.recording_failed`, `call.session_participant_joined` (room state only), `call.stats_report_ready` (records that a session's attendance record is final), `call.session_ended`, and `call.ended` (extracting `user.id` and `reason` for call termination auditing).

### Resend (`POST /api/webhooks/resend`)

- Executes `EmailEvent` creation (`@unique` on `svixId`) and recipient side effects inside **one atomic Prisma `$transaction(tx)`** under `PG_POOL_MAX=1`:
  - `email.bounced` (`Permanent`), `email.complained`, `email.suppressed`: upserts `EmailSuppression` and marks `NewsletterSubscriber` (`BOUNCED` / `UNSUBSCRIBED`).
  - `contact.deleted` & `contact.updated` (when `unsubscribed === true`): suppresses the recipient and marks `NewsletterSubscriber` (`UNSUBSCRIBED`).
  - `domain.updated` / `domain.deleted`: calls `recordSystemErrorSafe` after transaction commit if sending domain DNS verification degrades (`failed` / `not_started`) or is deleted.

---

## 3. Serverless Freeze Recovery & Schema Migration Discipline

1. **Netlify `after()` Container Freeze Recovery (`sweep-stuck-webhook-events`)**:
   - Because Razorpay (`5s`) and Stream (`6s`) require immediate `200 OK` responses before running domain logic inside Next.js `after()`, a serverless cold freeze or deployment rollout mid-callback leaves `WebhookEvent` rows in `processed = false, error = null`.
   - Every 15 minutes on the Netlify ticker (`scripts/cleanup/sweep-stuck-webhook-events.ts`), stale rows (>6 minutes old across `"razorpay"` and `"stream"`) are reclaimed via CAS lease fencing (`WebhookClaim` on `claimedAt`) and re-driven inside a per-event execution timeout.
2. **Zero-Downtime Schema Migrations (`PG_POOL_MAX=1`)**:
   - Keep maintenance windows **under 15 minutes** so Razorpay (24h window), Resend, and Stripe never hit endpoint auto-disable thresholds.
   - Always apply additive expand-and-contract DDL changes on `WebhookEvent`, `Payment`, `Refund`, `Dispute`, `EmailEvent`, and `Payout` tables; never acquire long-running `ACCESS EXCLUSIVE` locks that would stall `isDbHealthy()` past Razorpay's 5-second timeout.
   - Run `reconcile-payment-status`, `reconcile-pending-refunds`, `reconcile-disputes`, and `reconcile-payout-status` immediately after concluding any maintenance window.
3. **Weekly Multi-Table Retention (`archive-webhook-events`)**:
   - Prunes processed and failed `WebhookEvent` rows after **1 year (calendar)** and terminal `OutboundWebhookDelivery` rows after **30 days**, every Sunday shortly after UTC midnight, in 2,000-row batches until a batch comes back short or its 16-second budget is spent. `EmailEvent` rows are pruned by `prune-system-job-executions` after 1 year (calendar).

---

## Deprecated & Superseded Approaches

- **Uncompressed-Assumption Parsing Without Gzip Support**: Superseded by `POST /api/stream/webhooks` decompressing gzip payloads before verifying `X-Signature` over raw UTF-8 text and deduplicating on `X-Webhook-Id`.
- **Non-Atomic Resend Webhook Writes**: Superseded by single-transaction `EmailEvent` + `EmailSuppression` + `NewsletterSubscriber` commits so database blips during maintenance return HTTP `500` instead of losing bounce suppressions.
- **Inbound Novu webhook (`POST /api/webhooks/novu`, removed 2026-11-07)**: It never received an event, because `NOVU_WEBHOOK_SECRET` was never set. Novu's outbound webhooks are Team and Enterprise only, and `message.failed` does not cover in-app steps. Failed in-app steps are now read from Novu's activity feed by `novu-step-failure-probe` (decision 16 of `docs/decisions/2026-11-06-notification-single-preference-owner.md`). Delete any Novu receiver or `"novu"` provider arm that reappears.
