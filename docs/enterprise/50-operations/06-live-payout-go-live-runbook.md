---
title: Live-payout go-live runbook
band: 50-operations
audience: sde4
status: designed-not-active
last-reviewed: 2026-06-05
---

# Live-payout go-live runbook

> **Status:** `ENABLE_LIVE_PAYOUTS` is **OFF**. Payouts create rows and post
> `Dr *_PAYABLE / Cr CASH` but freeze at `PROCESSING` — money does **not**
> leave the gateway. This runbook makes flipping the flag a de-risked,
> one-variable operation. Related: [payout-pipeline](../10-money-and-ledger/06-payout-pipeline.md),
> [runbooks](03-runbooks.md).

The disbursement code is real (`lib/payments/payouts/org-payout-service.ts`
`submitOrgPayoutToGateway`, `razorpay-payouts.ts` `createPayout` — a live
RazorpayX POST). It is gated solely by `process.env.ENABLE_LIVE_PAYOUTS === "true"`.
The risk at go-live is paying the wrong amount/recipient on an unproven path, so
we prove the path in sandbox before flipping the production flag.

The gate, end to end — one flag, two states, with the prove-before-flip
path between them:

```mermaid
flowchart TD
  START["ENABLE_LIVE_PAYOUTS<br/>(lib/feature-flags.ts —<br/>OFF by default, redeploy to change)"]
  START -->|"false (today)"| FREEZE["process-payouts runs:<br/>posts Dr *_PAYABLE / Cr CASH,<br/>submittedToGateway = false,<br/>row freezes at PROCESSING<br/>(no money leaves)"]
  FREEZE --> PROVE["Sandbox proof:<br/>org-payout-sandbox-smoke.ts asserts<br/>gated behaviour + manual RazorpayX<br/>sandbox submit lands payout.processed"]
  PROVE --> CHECK{Pre-flip checklist<br/>all green?<br/>(KYB · secrets · VERIFIED accounts ·<br/>TDS/MSME · idempotency keys ·<br/>reconcile ok:true · telemetry on)}
  CHECK -->|"no"| FREEZE
  CHECK -->|"yes"| FLIP["Set ENABLE_LIVE_PAYOUTS=true<br/>+ redeploy → canary ONE<br/>small VERIFIED payout"]
  FLIP --> LIVE["next tick submits eligible<br/>PROCESSING payouts to RazorpayX<br/>→ COMPLETED on webhook"]
  LIVE -.->|"rollback: flag=false + redeploy"| STOP["new ticks stop submitting;<br/>already-submitted rows settle via<br/>webhook (can't un-send — clawback,<br/>reversal-engine.ts §C)"]
```

## Why a runbook and not just "flip the flag"

`processOrgPayout` reads the flag at call time. With it off, `submittedToGateway`
is always `false` and the row stays `PROCESSING`. Flipping it on makes the very
next cron tick submit **every** eligible `PROCESSING` payout to RazorpayX. That
is real money on the first run — so the prerequisites below are hard gates.

## Pre-flip checklist (all must be green)

- [ ] **RazorpayX account live** + KYB complete; the platform's RazorpayX
      balance is funded to cover the first batch.
- [ ] **Production secrets set** in the deploy env: `RAZORPAY_KEY_ID`,
      `RAZORPAY_KEY_SECRET` (RazorpayX-enabled), `RAZORPAYX_WEBHOOK_SECRET`.
- [ ] **Payout accounts VERIFIED** for every org/consultant in the first batch
      (`OrganizationPayoutAccount.status === "VERIFIED"`; the contact +
      fund-account side-channel finished provisioning).
- [ ] **TDS + MSME fields populated** on the payouts (`tdsAmountPaise`,
      `mustPayByDate` — both payout paths stamp these as of #776).
- [ ] **Idempotency keys present** (`payout_<profile>_<batch>`, NOT NULL) so a
      retry can never double-pay.
- [ ] **Sandbox proof done** (next section) — green.
- [ ] **Reconcile clean**: `reconcile-ledgers` reports `ok:true`, 0 findings
      (incl. `ORG_PAYOUT_TOTAL_MISMATCH`, `LEDGER_BALANCE_SNAPSHOT_DRIFT`).
- [ ] **Monitoring live**: `ENABLE_BETTERSTACK_TELEMETRY=true` so a stuck/failed
      payout pages someone (#776 §K — `handle-stuck-payouts` emits to the sink).
- [ ] **Rollback understood** (final section).

## Sandbox proof

Goal: prove the submission path is correct **without** touching the production
flag. The smoke asserts the gated behaviour and is safe to run anywhere:

```bash
# Asserts: with the flag OFF, processOrgPayout advances to PROCESSING and makes
# NO gateway submission (no providerPayoutId, money does not leave).
DATABASE_URL=… DIRECT_URL=… npx tsx scripts/smoke/org-payout-sandbox-smoke.ts
```

Sandbox-proof items, each mapped to an assertion the smoke makes (or a manual
step for the ones that need real sandbox creds):

| Proof item | How |
|---|---|
| Flag off ⇒ no disbursement | smoke: `submittedToGateway === false`, status `PROCESSING` |
| No money leaves while gated | smoke: `providerPayoutId == null` after process |
| TDS/MSME stamped before submit | inspect a real batch in staging (`tdsAmountPaise`, `mustPayByDate`) |
| Idempotency key never null | schema `@unique` + creator stamps `payout_<profile>_<batch>` |
| Real sandbox submit succeeds | **manual**: set `RAZORPAYX_SANDBOX_KEY`/`_SECRET`, submit one payout against the RazorpayX sandbox host, confirm the `payout.processed` webhook lands and `markOrgPayoutCompleted` fires |

## Flip procedure

1. Confirm the checklist + sandbox proof are green.
2. Set `ENABLE_LIVE_PAYOUTS=true` in the **production** deploy env (it's not a
   runtime toggle — a redeploy is required; this is intentional).
3. Redeploy.
4. **Canary**: ensure only ONE small, fully-VERIFIED payout is eligible for the
   first `process-payouts` tick (cancel/hold the rest). Watch it go
   `PROCESSING → COMPLETED` and confirm the `payout.processed` webhook +
   `notifyOrgPayoutCompleted`.
5. Reconcile (`reconcile-ledgers`) — expect 0 findings.
6. Release the held payouts.

## Rollback

- Set `ENABLE_LIVE_PAYOUTS=false` and redeploy. New ticks stop submitting; rows
  in `PROCESSING` that were already submitted continue to settle via webhook
  (you can't un-send a transfer — that's a clawback, see §C reversal engine).
- A stuck `PROCESSING` row (submitted, no terminal webhook) is handled by
  `jobs/payouts/handle-stuck-payouts` (reconcile against the gateway, retry, or
  fail). It now emits to the telemetry sink on permanent failure.
- A wrong disbursement is recovered via the reversal engine's `PAYOUT_CLAWBACK`
  source (`lib/payments/operations/reversal-engine.ts`) — ledger clawback is
  immediate; the gateway-side transfer reversal is the deferred #716 tail.
