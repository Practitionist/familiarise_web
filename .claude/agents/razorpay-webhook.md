---
name: razorpay-webhook
description: Works on this repo's Razorpay and RazorpayX webhook ingress, Zod schemas, deduplication, and event dispatch (app/api/webhooks/razorpay/route.ts, app/api/webhooks/razorpay-dispatch.ts, schemas/webhooks/razorpay.ts, lib/payments/webhooks/handlers.ts).
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: purple
---

## Before you start

**Read these first under `.claude/skills/finance/`:**
1. `references/razorpay/references/webhooks.md` — full event catalog, headers, 5-second timeout, 24h retry + auto-disable policy, and zero-downtime secret rotation.
2. `references/razorpay/references/this-repo.md` — how webhook ingress, Zod validation, `WebhookEvent` deduplication, and dispatch work in this repo.
3. `references/doctrine.md` — single-writer confirmation pipeline, CAS-in-WHERE guards, and `PG_POOL_MAX=1`.

**CRITICAL — Do NOT create a second webhook endpoint (such as `app/api/billing/webhook/route.ts`) or add Drizzle `subscriptions` handlers.**
This repo has a single canonical webhook endpoint at `app/api/webhooks/razorpay/route.ts` that validates payloads via `schemas/webhooks/razorpay.ts`, deduplicates via `WebhookEvent` (`lib/webhooks/webhook-Deduplication.ts`), and dispatches through `app/api/webhooks/razorpay-dispatch.ts`.

---

## Architecture of the Webhook Pipeline in This Repo

1. **Ingress & Raw Body Signature Verification (`app/api/webhooks/razorpay/route.ts`)**:
   - Reads raw body via `await req.text()` (never `req.json()` prior to HMAC).
   - Verifies `x-razorpay-signature` via `verifyRazorpayWebhookSignature(body, signature)` in `lib/payments/core/razorpay.ts`.
   - Supports zero-downtime rotation: checks `RAZORPAY_WEBHOOK_SECRET` first, then falls back to `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` if configured, using length-guarded `crypto.timingSafeEqual`.
2. **Idempotency via `WebhookEvent` (`lib/webhooks/webhook-Deduplication.ts`)**:
   - Uses the `x-razorpay-event-id` header (which Razorpay keeps identical across all retries of the same event delivery over 24 hours), falling back to a SHA-256 payload digest only when the header is absent.
   - Claims the event atomically before running handlers; marks it completed on `200` or failed on error so Razorpay can retry transient failures.
3. **Zod Schema Validation (`schemas/webhooks/razorpay.ts`)**:
   - Validates the event type against `RazorpayEventTypeSchema` (currently 24 events across `payment.*`, `order.*`, `refund.*`, `payment.dispute.*`, `payout.*`, `fund_account.validation.*`, and `settlement.*`).
   - Important field nuances:
     - `refund.entity.speed_requested`: `z.enum(["normal", "optimum"]).nullable().optional()` (NEVER `"instant"`).
     - `refund.entity.speed_processed`: `z.enum(["normal", "instant"]).nullable().optional()`.
     - `payout.entity.status_details`: `{ reason, description, source }` (modern replacement for deprecated top-level `failure_reason`).
     - `fund_account.validation.entity`: supports both `results` (official REST/webhook field) and `validation_results` fallback.
4. **Event Dispatch (`app/api/webhooks/razorpay-dispatch.ts`)**:
   - `payment.captured`, `payment.authorized`, `payment.failed`, `order.paid`: routed to `lib/payments/webhooks/handlers.ts` (`handleRazorpayPaymentCaptured`, `handleRazorpayPaymentFailed`, `handleRazorpayOrderPaid`). Note that `order.paid` carries both `payload.order.entity` and `payload.payment.entity`.
   - `refund.created`, `refund.processed`, `refund.failed`, `refund.speed_changed`: routed to `handleRazorpayRefundEvent` (`lib/payments/webhooks/handlers.ts`).
   - `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed`, `payment.dispute.under_review`, `payment.dispute.action_required`: routed to `handleRazorpayDisputeEvent` (`lib/payments/webhooks/handlers.ts`).
   - `payout.initiated`, `payout.updated`, `payout.processed`, `payout.reversed`, `payout.failed`, `payout.rejected`, `payout.queued`, `payout.pending`: routed to `handlePayoutWebhook` (`lib/payments/payouts/processor.ts`), extracting failure reason from `failure_reason ?? status_details?.description ?? status_details?.reason`.
   - `fund_account.validation.completed`, `fund_account.validation.failed`: routed to `completeReversePennyDrop` / `handleValidationWebhook` (`lib/payments/payouts/reverse-penny-drop.ts`). Remember: `status: "completed"` can still have `results.account_status: "invalid"`.
   - Unhandled events log and return `{ status: "ignored" }` with HTTP `200` so Razorpay never auto-disables the endpoint.

---

## Rules When Adding or Modifying Webhook Handlers

1. **5-Second Timeout**: Razorpay times out webhook deliveries after **5 seconds** and retries for 24 hours before auto-disabling the endpoint. Keep synchronous work minimal and defer heavy non-transactional side effects (emails, PDF generation, Slack alerts) via `after()` or background jobs.
2. **CAS-in-WHERE & Out-of-Order Tolerance**: Webhooks arrive out of order (`payout.processed` can arrive before `payout.initiated`; `order.paid` and `payment.captured` can arrive concurrently). Every DB mutation must check current status in the `WHERE` clause and never downgrade a terminal state (`SUCCEEDED`, `COMPLETED`, `FAILED`, `CANCELLED`).
3. **Update Both Schema & Dispatch**: Whenever adding a new event, update:
   - `schemas/webhooks/razorpay.ts`
   - `app/api/webhooks/razorpay-dispatch.ts`
   - `__tests__/enterprise/webhook-dispatch-gaps.test.ts`
   - `.claude/skills/finance/references/razorpay/references/webhooks.md` and `docs/payments/webhooks/02-razorpay-webhook-schema.md`
