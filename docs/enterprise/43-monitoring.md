# 24 — Monitoring & alerting

This document is the source of truth for every alert, metric, and
observability signal the enterprise platform emits. Pair it with
`42-runbooks.md` for the response procedures.

---

## Principles

1. **Structured logs, not print statements.** Every log line that's
   alertable has a stable `event` field that Cloud Logging routes to
   Datadog / Grafana / your observability stack of choice. Grepping
   random messages doesn't scale.
2. **Alerts trigger on symptoms, not causes.** We alert on "the wallet
   balance doesn't match the ledger" (symptom), not "a specific webhook
   retried" (cause). Causes live in logs; symptoms page humans.
3. **Every alert has a runbook.** If you can't write the response
   procedure in `42-runbooks.md`, the alert is too vague — tighten it.

---

## Log event taxonomy

All application logs use the following shape:

```ts
logger.info({
  event: "webhook.razorpay.received",
  provider: "razorpay",
  eventType: "payment.captured",
  eventId: "…",
  orgId: "…",
  durationMs: 42,
  ok: true,
});
```

The enterprise-critical `event` names are:

### Webhook lifecycle
- `webhook.razorpay.received` — inbound request (one per HMAC-verified event)
- `webhook.razorpay.processed` — downstream handler succeeded
- `webhook.razorpay.failed` — downstream handler threw
- `webhook.stripe.*` — same shape for Stripe
- `webhook.deduplicated` — idempotent replay short-circuited

### Wallet & invoice
- `wallet.topup.initiated` — order created, awaiting payment.captured
- `wallet.topup.confirmed` — webhook applied the credit
- `invoice.generated` — cron created a new `OrganizationInvoice`
- `invoice.paid` — payment captured against an invoice
- `invoice.irp.attempted` — IRP (e-invoice) upload attempted
- `invoice.irp.failed` — IRP upload failed (retry scheduled)

### Ledger & reconciliation
- `reconcile.started` — auditor began a run
- `reconcile.finding` — a single invariant broke (one per finding)
- `reconcile.completed` — auditor finished
- `ledger.transaction.serializable.retry` — `P2002`/serialization
  conflict triggered a retry at the Serializable isolation level

### Compliance
- `dpdp.consent.withdrawn` — user or admin withdrew consent
- `dpdp.sweeper.counted` / `dpdp.sweeper.deleted` — retention sweep
- `msme.alert.logged` / `msme.alert.sent` — MSME 43B(h) deadline alert

### Subscription cron
- `subs.invoice.claimed` — an individual subscription was claimed for
  billing (atomic `updateMany`)
- `subs.invoice.created` — invoice row created
- `subs.invoice.skipped` — already claimed by another worker

---

## Alerts

The thresholds below are starting points — tune them per tenant once
you have 30 days of traffic data.

### Critical (page on-call immediately)

| Alert | Condition | Runbook |
|-------|-----------|---------|
| Webhook queue backup | `count(webhook.razorpay.received) - count(webhook.razorpay.processed)` > 50 for 5 min | `42-runbooks.md#webhook-handler-is-backed-up` |
| Ledger reconciler failing | `reconcile.completed` with `ok=false` in the last 24h | `42-runbooks.md#ledger-reconciler-flagged-discrepancies` |
| Wallet balance drift | any `reconcile.finding` with `kind=WALLET_BALANCE_DRIFT` | Same |
| Subscription cron crash | `subs.invoice.created` count = 0 for 2 consecutive days while `BillingSubscription` rows with `nextInvoiceDate < now()` exist | N/A — page SRE |
| HMAC verification failing | `webhook.*.failed` with `reason=hmac_mismatch` rate > 1/min | Rotate secret or check load balancer stripping headers |

### Warning (Slack, no page)

| Alert | Condition |
|-------|-----------|
| IRP upload failure rate | `invoice.irp.failed` / `invoice.irp.attempted` > 20% rolling 1h |
| DPDP sweeper skipped | `dpdp.sweeper.counted` without a `dpdp.sweeper.deleted` follow-up for 7 days when `DPDP_SWEEPER_DELETE=true` |
| MSME alerts not firing | `msme.alert.logged` count = 0 for 48h |
| Stripe payouts gated off | `ENABLE_STRIPE_PAYOUTS=false` in a non-India deployment |

### Info (dashboard only)

| Metric | Purpose |
|--------|---------|
| `webhook.deduplicated` rate | Healthy baseline for vendor retry behaviour |
| `ledger.transaction.serializable.retry` rate | Rising rate signals contention hotspots |
| MRR / ARPU trends | Business-health dashboard |

---

## Dashboards

Keep each dashboard **single-responsibility**:

1. **Money dashboard**
   - Wallet balance by org (top 20)
   - Open invoices (`ISSUED` + overdue)
   - Last 24h payment volume (by gateway)
   - Last reconciler run status

2. **Ops dashboard**
   - Webhook backlog size
   - Subscription cron last run + row count
   - DPDP sweeper last run
   - MSME alerts last run + rows alerted

3. **Compliance dashboard**
   - Consent artifacts by state
   - IRP upload success rate
   - Retention sweeper delete count (when live mode is on)

---

## Manual spot-checks

Run these during release rollouts to confirm nothing regressed:

```bash
# Webhook smoke test (Razorpay)
node scripts/razorpay-test-webhook.ts --event payment.captured --org $ORG_ID

# Reconciler dry-run against production
curl -X POST "$PROD/api/admin/reconcile-ledgers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '.report.ok'

# MSME alert dry-run
MSME_ALERT_EMAIL=dev-null@familiarise.com npx tsx jobs/compliance/msme-payment-alerts.ts
```

All three should emit deterministic output — wrap them in Bash `set -e`
for CI.

---

## What we explicitly don't alert on

- **Individual failed logins** — SSO noise, handled by BetterAuth rate
  limiting.
- **Individual webhook retries** — Razorpay will retry up to 24h, and
  the dedup layer handles it. Alert only on aggregate backlog.
- **Cancelled subscriptions** — user action; the funnel analytics team
  owns this, not the SRE on-call.

This list grows over time. When in doubt, add the metric to the info
dashboard first; promote to warning/critical once you've seen the
baseline.

## Alerting sink — Better Stack Telemetry (#776 §K)

`recordSystemEvent` / `recordSystemError` (`lib/enterprise/system-events.ts`)
write the `SystemEvent` table (source of truth) and, when
`ENABLE_BETTERSTACK_TELEMETRY=true` with `BETTERSTACK_SOURCE_TOKEN` +
`BETTERSTACK_INGEST_URL` set, **also** ship a JSON event to the Better Stack
Telemetry logs HTTP ingest (`lib/observability/betterstack-telemetry.ts`,
Bearer source token). The sink is best-effort and off the critical path — an
ingest outage never blocks the caller.

Wired page-worthy callsites: failed/crashed ledger reconcile
(`jobs/reconcile/reconcile-ledgers.ts`), permanently-failed payouts
(`jobs/payouts/handle-stuck-payouts.ts`), outbound webhook queue backlog
(`jobs/cleanup/dispatch-outbound-webhooks.ts`), and inbound HMAC verification
failures (`app/api/webhooks/razorpay/route.ts`). This is distinct from
`lib/betterstack.ts`, which drives the Uptime/Incident-Management API for
maintenance windows.
