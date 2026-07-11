# Enterprise Concurrency, Deadlocks & Traffic Spikes

## Context

Enterprise concurrency is **Postgres-native** by ADR 13: conditional UPDATEs, unique constraints, sorted ledger account locks. Serializable appears on checkout, some governance, and crons — not on every point mutation. Redis locks protect booking/checkout and cron exclusion. Documented intent: [`docs/enterprise/30-programs-and-lifecycle/01-concurrency-and-idempotency.md`](../../docs/enterprise/30-programs-and-lifecycle/01-concurrency-and-idempotency.md). Chaos go/no-go covers B2C-heavy races; **enterprise 14c (seats, invoice void, wallet top-up replay) is staged, not blocking**.

## What works

| Path | Pattern |
|------|---------|
| Wallet debit | `updateMany WHERE walletBalance >= amount` |
| Engagement / credit cap BLOCK | Guarded `updateMany` on used/consumed |
| Assignment claim | `createMany skipDuplicates` + unique (program, membership, period) |
| Invite accept | Atomic pending→accepted claim + P2002 retry |
| Org capability flip | `expectedVersion` CAS + Serializable wind-down |
| Ledger postings | Sorted `accountId` balance updates |
| Invoice void vs pay | Status CAS |
| Org payout batch | Redis org lock + idempotency key |

## Known gaps / bugs

| ID | Severity | Issue |
|----|----------|-------|
| X-01 | **P1** | Chaos **14c unstaged** — N+1 seat assign, invoice generate-vs-void, wallet top-up replay not in go/no-go suite |
| X-02 | **P1** | SSO settings have `version` column but PATCH is **last-write-wins** (multi-admin) |
| X-03 | **P1** | SCIM provisioning **bypasses** unverified 5-seat invite governance |
| X-04 | **P1** | Docs claim `revokeSession` on member removal — **not implemented**; 5-min cookie membership lag |
| X-05 | **P2** | No contractual seat ceiling at assign — counter honest, commercial cap absent |
| X-06 | **P2** | JIT SSO auto-join may not bump `sessionGeneration` — sidebar lag |
| X-07 | **P2** | Long Serializable checkout + Redis event lock → timeouts under spike (pool #368), looks like deadlock |
| X-08 | **P2** | CREDIT_POOL lacks reserve-hold-TTL pattern used in industry credit engines — fine now, fragile at massive parallel enroll |

## Unhappy paths & multi-device psychology

- Two BILLING_ADMINs: one voids invoice on laptop, payment webhook marks PAID on phone — 409 is correct; support must explain.
- IT SCIM sync Friday 5pm + webinar last-seat + wallet bookings → 503 retry storms; users double-click; idempotency saves money, UX feels “broken.”
- Owner enables enforceSSO on tab A; tab B still has password form cached — phone login fails opaquely.
- HR assigns 200 seats from two scripts — billing counter races correctly upward; company disputes invoice vs purchased M seats.

## Illegal / deadlock-like states

True AB-BA DB deadlocks are mitigated by sorted ledger locks. Residual “deadlock feelings”:

- Redis lock held while Serializable retries exhaust (3×) → user stuck.
- Wallet row locked behind long checkout while another admin top-ups — waits, then succeeds/fails cleanly.
- Cron `failMode: open` if Redis absent — double cron possible (ADR risk).

## Questions (handled?)

1. **Stage chaos 14c before enterprise GTM?**  
   - A) Yes — hard gate  
   - B) Service-level tests enough  
   - C) Only after first design partner  

**Recommendation: A.** Enterprise money paths deserve the same go/no-go rigor as booking races.  
- Not B: Unit CAS ≠ API storm behavior.  
- Not C: First partner should not be the load test.

2. **SSO settings CAS?**  
   - A) Wire `expectedVersion` like org PATCH  
   - B) Accept last-write-wins  
   - C) Single-admin lockout for SSO edits  

**Recommendation: A.** Security settings must not silently clobber across devices.  
- Not B: EnforceSSO flip is too dangerous for LWW.  
- Not C: Overkill if version CAS works.

3. **Seat ceiling enforcement?**  
   - A) Enforce purchased seats at assignment  
   - B) Bill whatever counter says (current)  
   - C) Soft warn only  

**Recommendation: A.** Fail closed on revenue seats under concurrency (industry standard).  
- Not B: Over-assign then dispute is predictable gaming.  
- Not C: Warns don’t stop scripts.

## High concurrency / multi-device / spikes

Millions of users: bottleneck is **Postgres pool + Serializable checkout**, not Redis for wallet CAS. Multi-tab: refetch after every 409. SCIM bulk should be rate-limited and isolated from checkout pool (separate connection budget or queue). Month-end: claim-gated invoice cron + void CAS are sound if chaos-tested.

## Suggested directions

1. Implement and green-bar chaos 14c.  
2. SSO version CAS; SCIM seat governance parity.  
3. Implement or delete `revokeSession` docs.  
4. Plan CREDIT_POOL reserve-hold if enroll becomes long-running.
