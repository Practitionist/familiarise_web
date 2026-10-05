# Razorpay Reference — Familiarise Platform

Reference material for the Razorpay + RazorpayX integration in this repository. All claims have been verified against the live codebase (`lib/payments/`, `app/api/webhooks/razorpay/`, `schemas/webhooks/razorpay.ts`) and official Razorpay documentation (`https://razorpay.com/docs/`).

**Start with [`references/this-repo.md`](references/this-repo.md)** — it maps our files (`lib/payments/**`, `app/api/webhooks/razorpay/**`) to the concepts below and lists what we use vs. what we deliberately don't.

## Reference Index (`references/`)

| File | Load when working on… |
|---|---|
| [`this-repo.md`](references/this-repo.md) | **Read first.** File map, env vars, Prisma models, what we use vs. don't (`Orders` + `Refunds` + `Disputes` + `Customers` + `RazorpayX`; **not** Subscriptions, Route, or Razorpay Invoices). |
| [`orders-and-checkout.md`](references/orders-and-checkout.md) | `createRazorpayOrder`, per-order `payment.capture_options`, `RazorpayCheckout.tsx`, `buildCheckoutOptions`, `/api/checkout/verify-signature`, `order_id\|payment_id` HMAC, `order.paid` vs `payment.captured`. |
| [`customers-and-saved-cards.md`](references/customers-and-saved-cards.md) | `ensureRazorpayCustomer` (`fail_existing: 0`), RBI Card-on-File Tokenisation (CoFT) on Standard Checkout (`customer_id`, `remember_customer`), token deletion (`deleteRazorpayCustomerTokens`), GDPR PII overwrite (`eraseRazorpayCustomerPii`). |
| [`webhooks.md`](references/webhooks.md) | `app/api/webhooks/razorpay/route.ts`, `signature.ts`, `razorpay-dispatch.ts`: raw body cap, dual-secret rotation (`RAZORPAY_WEBHOOK_SECRET_PREVIOUS`) + RazorpayX secret fallback, `after()` 5s timeout pattern, synthesized tamper-proof `eventId`, `DeferSignal`. |
| [`refunds.md`](references/refunds.md) | `postRefund` raw-HTTP (`X-Refund-Idempotency` ≥10 chars `[A-Za-z0-9_-]`), why `razorpay-node` drops custom headers, HTTP 409 handling, two-phase reservation (`pending_<uuid>`), `speed` (`normal` / `optimum`) vs `speed_processed` (`normal` / `instant`), `reconcile-pending-refunds.ts`. |
| [`disputes.md`](references/disputes.md) | All 6 `payment.dispute.*` webhooks (`created`, `won`, `lost`, `closed`, `under_review`, `action_required`), REST Disputes & Documents API (`GET /v1/disputes/:id`, `POST /v1/documents`, `PATCH /v1/disputes/:id/contest`) in `lib/payments/core/razorpay-disputes.ts`, `respond_by` (Unix seconds), `deduct_at_onset`, `reconcile-disputes.ts`. |
| [`payouts-razorpayx.md`](references/payouts-razorpayx.md) | `lib/payments/payouts/razorpay-payouts.ts`: Contact → FundAccount → Payout flow, mandatory `X-Payout-Idempotency` (4–36 chars `[A-Za-z0-9 _-]`, `boundPayoutIdempotencyKey`), mode selection (`UPI` ≤ ₹1L / `IMPS` ≤ ₹5L / `NEFT` / `RTGS` ≥ ₹2L), `status_details` vs deprecated `failure_reason`, `payout.*` webhooks (`payout.initiated` = `processing`). |
| [`fund-account-validation.md`](references/fund-account-validation.md) | RazorpayX Penny Drop (`validateBankAccount`) & Reverse Penny Drop via UPI Intent (`createReversePennyDrop`, `lib/payments/payouts/reverse-penny-drop.ts`): `/v1/fund_accounts/validations`, why `status: "completed"` can still carry `results.account_status: "invalid"`, `results` vs `validation_results`, Test Mode & RazorpayX Lite constraints. |
| [`gst-invoicing.md`](references/gst-invoicing.md) | Why Razorpay's `/v1/invoices` API is **non-GST only** (`tax_rate`/`sac_code`/`hsn_code` cannot be set via API), and how our own `Invoice` / `OrganizationInvoice` + `lib/payments/tax/tax-engine.ts` handles SAC `999293`, CGST+SGST vs IGST, LUT export, and credit notes. |
| [`api-quirks.md`](references/api-quirks.md) | Verified Razorpay & `razorpay-node` v2.9.6 quirks: SDK header whitelist, no SDK timeout (`withRazorpaySdkTimeout` + circuit breaker), 400 vs 404 on unknown IDs, 3-day vs 5-day (`7200` min) capture expiry doc discrepancy, `notes` & `receipt` limits, integer paise rules. |
| [`go-live.md`](references/go-live.md) | Test → Live checklist for this repo: PM-10 boot guards (`RAZORPAY_TEST_KEY_IN_PRODUCTION`, `RAZORPAYX_TEST_KEYS_IN_LIVE_MODE`), dual webhooks, secret rotation grace (`RAZORPAY_WEBHOOK_SECRET_PREVIOUS`), RazorpayX IP allowlisting, PA-CB international activation & FIRS. |
| [`international-pa-cb.md`](references/international-pa-cb.md) | Razorpay International Cards (130+ currencies), Apple Pay, PayPal wallet integration, MoneySaver Export Account (Virtual USD ACH / EUR SEPA / GBP FPS at 1% + GST), RBI PA-CB ₹25L per-unit cap, purpose codes (`P1007`/`P0802`), and automated FIRS/e-FIRA. |
| [`debugging.md`](references/debugging.md) | Runbooks for signature mismatches, `DeferSignal` stuck webhooks, `409 Conflict` on refunds/payouts, unresolvable/unknown gateway IDs, and circuit breaker trips. |
| [`local-testing.md`](references/local-testing.md) | Official Razorpay test cards (`4100 2800 ...`, international `4012 8888 8888 1881`), test UPI VPAs (`success@razorpay`, `failure@razorpay`), repeated-digit phone rejection (`9999999999`), and local signed webhook simulation. |
| [`admin-queries.md`](references/admin-queries.md) | Read-only SQL diagnostics against our Prisma/Postgres tables (`Payment`, `Refund`, `Dispute`, `WebhookEvent`, `ConsultantPayout`, `OrganizationPayout`, `LedgerTransaction`) and `curl` commands for Razorpay / RazorpayX APIs. |

## `references/not-used-here/`

Material on Razorpay **Subscriptions** (`/v1/plans`, `/v1/subscriptions`), recurring dunning, customer billing portals, SaaS MRR/churn metrics, and Stripe-to-Razorpay subscription migration. **This repo does not use Razorpay's Subscriptions API** — consultant "subscriptions" are multi-session booking packages billed via one-time Razorpay Orders (`POST /v1/orders`) or B2B organization invoices/wallets. Kept in `not-used-here/` only as reference if recurring auto-debit is ever evaluated in the future.

## Drift Check

[`scripts/check-doc-drift.sh`](scripts/check-doc-drift.sh) greps `.claude/` and `docs/payments/` for known Razorpay anti-patterns (wrong signature payload order, `"instant"` in `speed_requested`, `pause_initiated_by` as a request param, `timingSafeEqual` without a length check, Stripe `4111`/`4000` test cards in Razorpay docs, or claims that Razorpay has no Disputes REST API). Run after editing any Razorpay doc or skill: <!-- drift-ok -->

```bash
bash .claude/skills/finance/references/razorpay/scripts/check-doc-drift.sh
```
