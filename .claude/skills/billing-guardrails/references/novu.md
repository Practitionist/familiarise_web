# Novu

## 1. Plan and limits

Free is the planned plan (confirmation date kept in Notion, Familiarise / Finance and Pricing / Vendors & Spend), and `docs/notifications/05-pre-production-checklist.md` plans for it (10,000 workflow runs a month, 20 active workflows, 24-hour activity retention, 16 families deployed, in-app channel only). VERIFIED 2026-10-17 from [novu.co/pricing](https://novu.co/pricing/): Free is 10,000 workflow runs a month, 20 workflows, 24-hour activity retention; Team is 250,000+ runs, 100 workflows, 90-day retention and $1.20 per 1,000 additional runs; subscribers are unlimited. The overage behaviour on Free is not stated on the page (unknown); treat the 10,000 runs as a hard ceiling.

## 2. What causes surprise bills or outages

- One trigger per recipient is one run: a fan-out to 1,000 users spends 10 percent of the free month.
- Development and Production are separate tenants with separate keys, but owner decision 2026-11-06 is to treat the monthly runs as counted across **both** environments (one quota). Development testing, previews and local runs all spend the same 10,000 runs, so keep them small. A preview that holds the production key spends production traffic. (The pricing page does not state this; it is the conservative planning assumption.)
- Check the monthly run count against the upgrade trigger kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend). There is no Novu usage meter, so count from our own table: a planned ops-digest line sums the recipients of `SENT` `NotificationOutbox` rows for the month.
- Retried triggers count again unless idempotent.
- The 20-workflow cap stops new families, not billing.

## 3. Exposure in this repo

- `lib/novu/secret-key.ts` selects `NOVU_PRODUCTION_KEY` only when `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`; everything else uses `NOVU_DEVELOPMENT_KEY`. Keep previews on the development key.
- Notifications go through the `NotificationOutbox` table, drained by the `drain-notification-outbox` ticker target every 10 minutes with up to 100 rows per run (`TARGET_LIMITS`); each row attempt is one bulk call of at most 100 events. A retry after an unknown outcome reuses the row's Idempotency-Key, so Novu dedupes it instead of counting new runs. This bounds Novu calls per tick and prevents retry storms; it does not bound total volume.
- An announcement inbox post is the only audience-wide fan-out. It is opt-in (`postToInbox`), capped at `MAX_BELL_AUDIENCE` (2,000 recipients, `lib/novu/policy.ts`), and the announcement dialog shows the eligible count and asks for confirmation that each recipient uses one run. Maintenance bells no longer exist, so a maintenance window spends no runs.
- Bell policy (`lib/novu/policy.ts`) drops opted-out recipients at staging and again at the attempt, before they become runs.
- `novu-step-failure-probe` reads `GET /v1/notifications` every 2 hours, at most 10 pages a run, so at most 120 reads a day. Reads spend no workflow runs. Each costs one token of the global rate-limit category (30 requests a second on Free, [rate limiting](https://docs.novu.co/api-reference/rate-limiting)), and a `429` stops the run's paging.

## 4. Guardrails to set

Novu dashboard, Settings: usage alerts if offered on the plan (unknown). Keep fan-out jobs batched through the outbox. Before any broadcast, count recipients and price runs.

## 5. Monitor

Novu MCP `get_notifications` and `get_workflows` list recent runs and workflow counts; the dashboard Activity Feed shows volume. There is no MCP usage meter (unknown).
