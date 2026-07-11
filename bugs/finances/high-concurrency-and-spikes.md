# High Concurrency & Traffic Spikes

## Context

Money paths already assume concurrency: Redis checkout locks, Serializable isolation, wallet conditional updates, webhook dedup, payout idempotency keys, ledger sorted locks. GitHub Actions crons backstop orphans, stuck webhooks, earnings sync, refund cascade, and ledger drift. Race tests exist under `tests/typescript/race-conditions/` (webhook storms, cancel-vs-webhook).

## Known gaps / bugs

- Prisma pool exhaustion risk when long Serializable checkout/allocation txs pile up (#368).
- Event checkout fail-closed on Redis outage (503) — correct for seats, harsh for conversion at peak.
- Consultation path relies more on DB GiST if Redis fails — asymmetric.
- Cron jitter (Actions) means tentative cleanup / sweeper delay under load.
- Hot consultant auto-allocate lock serializes an entire consultant — bottleneck during flash sales.

## Unhappy paths & user psychology

- Flash webinar: 500 users hit last 10 seats — many see 409/503; some pay and lose at confirm; support floods.
- Payment success emails lag Phase-2 — users refresh and create duplicate tickets.
- Org wallet mega-booking day: sequential debit contention → intermittent failures feel like “site broken.”

## Questions (handled?)

1. **Load-test target for checkout QPS and webhook burst before marketing spikes?**  
   - A) Formal k6/Gatling gate in CI monthly  
   - B) One-off pre-launch test only  
   - C) Rely on race unit suite  

2. **Redis down during peak — fail closed everywhere or degrade 1:1 to DB-only?**  
   - A) Fail closed all paid checkout  
   - B) Events fail closed; 1:1 continue on GiST  
   - C) Queue checkout intents for later processing  

3. **Move booking/money crons from Actions to a real queue (#866)?**  
   - A) Inngest/BullMQ near-term  
   - B) Keep Actions until scale pain  
   - C) Hybrid: critical sweepers on always-on worker  

## High concurrency / multi-device

Same user across phone + laptop should be serialized by `lockConsulteeBooking` for booking-shaped payments. Different users on same slot: expect one winner; losers need clear UX (“slot taken — refund processing”). Idempotency keys must survive mobile WebView reloads.

## Suggested directions

Define a “payment succeeded / booking pending” status page. Page on-call for webhook sweeper lag during campaigns.
