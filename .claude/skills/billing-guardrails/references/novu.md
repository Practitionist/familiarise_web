# Novu

## 1. Plan and limits

The plan in use is not recorded as a fact; `docs/notifications/05-pre-production-checklist.md` assumes the Free plan (10,000 events a month, 20 active workflows per tenant, 7-day activity retention, 16 families deployed, in-app channel only). VERIFIED 2026-10-17 from [novu.co/pricing](https://novu.co/pricing/): Free is 10,000 workflow runs a month, 20 workflows, 24-hour activity retention (the repo checklist says 7 days; the page now says 24 hours); Team is 250,000+ runs, 100 workflows, 90-day retention and $1.20 per 1,000 additional runs; subscribers are unlimited. The overage behaviour on Free is not stated on the page (unknown); treat the 10,000 runs as a hard ceiling.

## 2. What causes surprise bills or outages

- One trigger per recipient is one run: a broadcast to 1,000 users spends 10 percent of the free month.
- Development and Production are separate tenants with separate keys; a preview that holds the production key spends the production quota.
- Retried triggers count again unless idempotent.
- The 20-workflow cap stops new families, not billing.

## 3. Exposure in this repo

- `lib/novu/secret-key.ts` selects `NOVU_PRODUCTION_KEY` only when `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`; everything else uses `NOVU_DEVELOPMENT_KEY`. Keep previews on the development key.
- Notifications go through the `NotificationOutbox` table, drained by the `drain-notification-outbox` ticker target every 10 minutes with 20 rows per run (`TARGET_LIMITS`). This bounds Novu runs per tick and prevents retry storms; it does not bound total volume.
- Quiet hours and policy (`lib/novu/quiet-hours.ts`, `lib/novu/policy.ts`) suppress sends before they become runs.

## 4. Guardrails to set

Novu dashboard, Settings: usage alerts if offered on the plan (unknown). Keep fan-out jobs batched through the outbox. Before any broadcast, count recipients and price runs.

## 5. Monitor

Novu MCP `get_notifications` and `get_workflows` list recent runs and workflow counts; the dashboard Activity Feed shows volume. There is no MCP usage meter (unknown).
