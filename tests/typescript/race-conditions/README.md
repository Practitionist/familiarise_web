# Race and chaos harness

Scenario scripts under `scenarios/`, each a standalone `tsx` process that exits 0 (pass or skip) or 1 (fail). `master-runner.ts` runs them by category.

| Category                              | Kind                                                     | Needs                                                                             |
| ------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 01 to 06, 10, 11                      | In-process simulation (in-memory registry, lock helpers) | Nothing; set `USE_MOCK_REDIS=true` to keep real Upstash keys untouched            |
| 07 real-api-booking, 09 webhook-storm | Drives the real app over HTTP                            | Seeded DB, a reachable server, `CHAOS_BASE_URL` (default `http://localhost:3000`) |

Runbook: `docs/enterprise/50-operations/06-chaos-test-runbook.md`.

```bash
USE_MOCK_REDIS=true npx tsx tests/typescript/race-conditions/master-runner.ts sequential --category=01-concurrent-access
CHAOS_BASE_URL=https://<deploy>.netlify.app npx tsx tests/typescript/race-conditions/scenarios/07-real-api-booking/test-last-seat-storm.ts
```

## Invariants the scenarios assert

- A guarded mutation may legally have more than one winner when its serial order is legal (approve then reject is `{200,200}`). Assert the final state, the recorded `BookingStatusHistory` chain, and the absence of doubled side effects, not a single 2xx.
- Webhook rows are stored as `<event>:<entityId>:<bodyHash>`; look them up by the `<event>:<entityId>:` prefix.
- Fixtures the harness needs but the seed lacks (the reschedule-storm consultation) are created and deleted by the scenario.

## Teardown rules (shared DB)

`utilities/teardown.ts` holds the shared helpers.

- Release `PENDING` checkout holds with `releasePendingHolds` (`DELETE /api/checkout/pending/:id`, then a CAS to `EXPIRED`). Never delete `PaymentLeg` rows under a live payment: `payment_legs_sum_to_amount` rejects it, and the leftover `PENDING` payment is later replayed as a 200.
- A `SUCCEEDED` payment with no appointment is retired with `retireOrphanSucceededPayments`, which prefixes its `description` with `REQUIRES_MANUAL_RECOVERY: race harness fixture` so the orphan sweeps skip it.
- Back-office scenarios log in as `CHAOS_ADMIN_EMAIL` (default `olivia.brown@protonmail.com`); a deployed target answers 428 `TWO_FACTOR_REQUIRED` unless that account has an enrolled TOTP session in the cookie cache.

## Deploy previews and `isMockPayment`

`isMockPayment` cannot be honoured on a deploy preview. `app/api/checkout/route.ts` keeps the flag only when `NODE_ENV === "development"`, and a preview is a production build; `ENABLE_MOCK_PAYMENTS=true` only widens the second gate in `createPaymentIntent` and cannot override the first. So on a preview every booking round creates a Razorpay TEST-key order (unpaid, no money moves) and its winner stays `PENDING`, which teardown releases through the API. To get instant mock confirmation, run the scenario against a local `next dev` server (shared DB, seeded users only).
