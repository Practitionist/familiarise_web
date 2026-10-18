# Booking E2E — Shared Setup for Agents 013–020

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000` (or the Netlify deploy preview under test)

Read this file first. **One Supabase project serves both development and
production**, so every write below is a production operation on prefixed fixtures:
touch only rows your run created, never run a seed, reset or `db push`, and never
point a case at a customer account. If you cannot confirm that the fixtures are
prefixed and the cleanup phase will run, stop before the first write. Agents 013–020 exercise the hard cases the earlier cases
skip: duplicate submits, two devices, stale clients, races, caps, org scope, DST,
webhook disorder, abandoned sweeps and refunds owed. Each of them follows the
shape of Agents 001–012: Phase 0 seeds with SQL, later phases drive the real
`/api/bookings/*`, `/api/appointments/*`, `/api/scheduling/*` and `/api/checkout`
routes, every step asserts HTTP status **and** database truth through the Supabase
MCP, and the last phase cleans up.

## Tools

- **Supabase MCP** — SQL against the project above. The database is the arbiter.
- **Chrome DevTools MCP** — `evaluate_script` for `fetch()` calls as a signed-in
  user; use two pages (or one normal and one incognito-style context) when a case
  says "two tabs" or "two devices".

## Rules every case obeys

1. **FIX BUGS IMMEDIATELY.** Stop, fix the source, retest the whole phase.
2. **Prefix every fixture** with the case's agent number (`-013`, `-014`, …) so a
   rerun never collides and a stray row is recognisable.
3. **Pin `D` to a weekday.** Each case names the weekday `D` falls on and books
   relative to it; seeded availability is weekday-specific.
4. **Book at least 3 days out** so the notice tiers do not move mid-run.
5. **Seed weekly availability with its local columns.** Every reader refuses a
   weekly row whose `timezone` or `local*` columns are NULL. A SQL-seeded row sets
   `timezone`, `localStartDay`, `localStartMinutes`, `localEndDay`,
   `localEndMinutes` and the UTC columns. Convention: `Asia/Kolkata`, offset `330`,
   local minutes = UTC minutes + 330 (carry into the next day past 1440), unless
   the case names another zone.
6. **Never delete a row a `Payment` points at.** `Payment.appointment` is
   `onDelete: Restrict`, so Postgres will refuse; clean up payments, legs and
   earnings first, as Agent 001's cleanup does.
7. **Mock payments** (`isMockPayment: true`) work only when the server runs with
   `NODE_ENV=development`. Cases that need a real PENDING payment (an open order)
   need Razorpay **test-mode** keys; if the server has none, mark that phase
   SKIPPED with the reason instead of faking it.
8. **Sentry may be quota-blind.** The free plan allows 5,000 errors a month. Before
   concluding "no error was raised", run `find_dropped_events` or read the stats
   API for `rate_limited`, then read the **Netlify function logs** of the deploy
   under test. Sweeps report once per run (`createRunFailureReporter`) and standing
   findings once per id per day (`reportStandingFinding`), so ten failing rows are
   one event with `count: 10`.
9. **Retire synthetic webhook events.** Any `WebhookEvent` row you insert or replay
   must be made terminal before cleanup, or `sweep-stuck-webhook-events` will
   re-drive it:

   ```sql
   UPDATE "WebhookEvent"
   SET error = 'permanent: qa fixture', processed = true, "processedAt" = NOW()
   WHERE "eventId" LIKE 'qa-<AGENT>-%';
   ```

## Recipes

**Run a sweep on demand.** Every job has an HTTP twin: `GET`
`/api/cleanup/<job>?limit=<N>` with `Authorization: Bearer <CRON_SECRET>`. Slugs
used here: `abandoned-payments`, `retry-auto-refunds`, `reconcile-refunds`,
`auto-complete-appointments`, `detect-consultant-no-shows`, `expire-stale-requests`,
`tentative-occurrences`, `reschedule-proposals`, `sweep-stuck-webhook-events`. A
`limit` that is not a positive integer answers 400 `INVALID_LIMIT`.

**Replay a signed webhook.** Post to `/api/webhooks/razorpay` with the exact body
bytes signed by HMAC-SHA256 under `RAZORPAY_WEBHOOK_SECRET`
(`x-razorpay-signature`) and a unique `x-razorpay-event-id` (use
`qa-<AGENT>-<n>`). The full recipe is in
`.claude/skills/finance/references/verification.md` ("Replaying a webhook").

**Read the refund-owed marker.**

```sql
SELECT id, "paymentStatus", "refundOwedKey", "refundOwedPaise",
       "refundOwedReason", "refundOwedAt", "refundOwedAttempts"
FROM "Payment" WHERE id = '<PAYMENT_ID>';
```

**Cleanup order (QA-created rows only).** Refund and ledger rows your run created
are append-only evidence: leave them and record their ids. Delete in this order:
`BookingStatusHistory`, `AppointmentParticipant`, `AppointmentOccurrence`,
`PaymentLeg`, `ConsultantEarnings`, `Payment`, then `Appointment`, then the
`Consultation`/`Subscription`/plan rows, then profiles and users. If a delete is
refused by a foreign key, a payment or refund still points at it: stop and leave
the row, do not work around the constraint.
