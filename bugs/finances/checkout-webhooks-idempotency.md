# Checkout, Webhooks & Idempotency

## Context

`POST /api/checkout` → `handleCheckout()` creates a PENDING `Payment` plus tentative slots under Redis + Serializable guards. Gateway order/session is minted; user pays via Razorpay.js (or Stripe). Razorpay webhooks verify HMAC, dedup via `WebhookEvent`, return 200 fast, and process in `after()`. Success confirms slots; failure deletes tentatives. Client HMAC verify exists as defense-in-depth only — webhook remains authoritative.

Key paths: `lib/payments/operations/checkout.ts`, `app/api/webhooks/razorpay/`, `lib/payments/webhooks/handlers.ts`.

## Known gaps / bugs

- Async `after()` processing means ACK-before-complete; stuck events rely on `sweep-stuck-webhook-events` cron (minutes-level gap).
- Refund-before-capture race uses `DeferSignal` — correct but easy to mis-ops if sweeper cadence slips.
- Amount parity failure can leave funds captured while booking blocked (`REQUIRES_MANUAL_RECOVERY`).
- Stripe path processes sync (no `after()`) — asymmetric timeout/retry behavior vs Razorpay.
- `allocationIdempotencyKey` on appointments is schema-only (#837) — allocate double-submit not fully covered by payment idempotency.

## Unhappy paths & user psychology

- Double-click / back-button / second tab: user thinks first pay failed and tries again — mitigated by `clientIdempotencyKey` if the client remints carefully; remounting checkout can mint a *new* key.
- Payment app switches to UPI on phone while checkout started on desktop — browser session may expire while Razorpay still captures.
- User closes modal after bank OTP; webhook still succeeds — they see no UI confirmation until refresh.
- Org wallet checkout: balance looks enough on screen A; screen B spends wallet first; screen A fails mid-flow with confusing error.

## Questions (handled?)

1. **After amount mismatch (gateway ≠ Payment.amount), auto-refund or manual confirm?**  
   - A) Always auto-refund + Sentry P0  
   - B) Manual ops with 24h SLA (current leaning)  
   - C) Partial capture / adjust booking price only with admin approval  

**Recommendation: A.** Auto-refund amount mismatches and page Sentry P0 — captured funds with a blocked booking must not wait on a 24h ops SLA.
- Not B: Manual recovery leaves consultees charged while `REQUIRES_MANUAL_RECOVERY` sits.
- Not C: Partial capture / price adjust invents a second money path instead of returning the wrong capture.

2. **Should checkout remount reuse the same `clientIdempotencyKey` for a given cart fingerprint?**  
   - A) Persist key in sessionStorage keyed by plan+slots  
   - B) Mint fresh each mount; rely on paymentIntent uniqueness  
   - C) Server-side “open PENDING payment for this user+plan” reuse  

**Recommendation: C.** Reuse an open PENDING payment server-side for the same user+plan so remounts, tabs, and WebViews cannot mint parallel charges.
- Not A: sessionStorage helps one browser only and fails across phone/desktop checkout.
- Not B: Fresh keys on every mount are exactly how double-pay unhappy paths start.

3. **Is asymmetric Razorpay-async vs Stripe-sync acceptable long-term?**  
   - A) Unify both on async + sweeper  
   - B) Delete Stripe per gateway evaluation  
   - C) Keep Stripe sync for test-only  

**Recommendation: B.** Delete unused Stripe per the gateway evaluation so Razorpay-async + sweeper is the only production money path.
- Not A: Unifying Stripe onto async invests in a dual-rail we intend to exit.
- Not C: Test-only Stripe still leaves asymmetric timeout/retry behavior in the codebase.

## High concurrency / multi-device

Webhook storms are covered by unique `eventId` and early-return if payment already SUCCEEDED. Overlapping slot captures use Serializable + confirm-time overlap recheck (#827). Under spike, Redis lock TTL for CLASS can be 300s — serverless freeze may lose lock ownership; extendLock helps once.

## Suggested directions

Document ops runbooks for: stuck PENDING, amount mismatch, loser-of-double-booking refund. Prefer one checkout key strategy across web and any future mobile WebView.
