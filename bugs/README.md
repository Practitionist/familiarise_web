# Bugs — CTO Subsystem Audit Pack

High-level investigation notes for Familiarise: incomplete work, concurrency traps, multi-device unhappy paths, and open architecture questions. This is **not** a ticket tracker and **not** a rewrite of `docs/` — it is a CTO lens that points at real gaps found in code and docs.

## How to read

1. Start with **finances** (mission-critical money movement).
2. Then **booking** (inventory + payment handshake).
3. Then **enterprise**, **stream**, **compliance**.
4. Skim secondary folders for growth/trust/ops risk.
5. Read **cross-cutting** last for multi-device psychology and deadlock patterns that span products.

Each markdown follows: Context → Known gaps → Unhappy paths → Questions (A/B/C) → Concurrency / multi-device → Suggested directions.

After every A/B/C question, a **Recommendation** names the preferred option with a short why, plus why-not for the other two. Recommendations are CTO judgment for Familiarise *now* (money/booking safety, India launch, design-partner gates)—not irreversible product law.

## Severity legend

| Tag | Meaning |
|-----|---------|
| **P0** | Revenue integrity, legal unenforceability, or security that can mint wrong access / money |
| **P1** | Consistency debt that creates ops burden or user distrust at moderate scale |
| **P2** | Deferred / flagged / scale-future; safe to ship with eyes open if documented |
| **Q** | Product or policy decision still open — engineering cannot close alone |

Questions use **A / B / C** short approaches. They are not ranked recommendations unless marked.

## Index

### Mission-critical

| Folder | Focus |
|--------|--------|
| [finances/](finances/) | Checkout, webhooks, payouts, refunds, disputes, ledger, FX, tax |
| [booking/](booking/) | Slots, locks, double-booking, cancel/reschedule/no-show |
| [enterprise/](enterprise/) | Orgs, RBAC, onboarding race, seats, SSO |
| [stream/](stream/) | Chat, video, tokens, recordings, multi-tab calls — **P0:** [recording storage scale](stream/recording-storage-scale-infrastructure.md) |
| [compliance/](compliance/) | TDS/GST/DPDP, legal pages, grievance, audit |

### Secondary

| Folder | Focus |
|--------|--------|
| [feedback-reviews/](feedback-reviews/) | Platform feedback vs consultant ratings |
| [support/](support/) | Tickets, SLA, entity-linked disputes |
| [explore-discovery/](explore-discovery/) | Browse, search, PII, community |
| [waitlist/](waitlist/) | Queue, notify, seat hold |
| [referrals/](referrals/) | Attribution, credits, farming |
| [collaborators/](collaborators/) | Co-hosts, revenue split |
| [notifications/](notifications/) | Resend, Novu, push/SMS gaps |
| [auth-onboarding/](auth-onboarding/) | Single role, dual-profile UX |

### Cross-cutting

| File | Focus |
|------|--------|
| [cross-cutting/multi-device-psychology.md](cross-cutting/multi-device-psychology.md) | Tabs, phones, iPads, same-email dual flows |
| [cross-cutting/deadlocks-and-inconsistencies.md](cross-cutting/deadlocks-and-inconsistencies.md) | Lock order, Phase-2 windows, doc/code drift |

## Reading order (suggested)

1. [finances/00-overview.md](finances/00-overview.md)
2. [booking/00-overview.md](booking/00-overview.md)
3. [stream/recording-storage-scale-infrastructure.md](stream/recording-storage-scale-infrastructure.md) (P0 media durability)
4. [enterprise/onboarding-multi-device-role-race.md](enterprise/onboarding-multi-device-role-race.md)
5. [stream/chat-security-and-roles.md](stream/chat-security-and-roles.md)
6. [compliance/b2c-vs-b2b-gaps.md](compliance/b2c-vs-b2b-gaps.md)
7. [cross-cutting/multi-device-psychology.md](cross-cutting/multi-device-psychology.md)

## Related docs (canonical engineering)

- `docs/booking/`, `docs/payments/`, `docs/enterprise/`, `docs/stream/`, `docs/compliance/`
- Race suite: `tests/typescript/race-conditions/`
- Feature flags: `lib/feature-flags.ts`

---

*Generated as an architecture audit pack. Update when go-live gates flip or P0 gaps close.*
