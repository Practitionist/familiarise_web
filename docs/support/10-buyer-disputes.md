# Buyer disputes — the two-party adjudication protocol

A buyer disputes a session they paid for. That is a different thing from a
gateway chargeback (the card issuer says the money was taken fraudulently)
and a different thing from a support ticket (the buyer needs help). This
document describes the protocol that sits between them.

The reference product this was modelled on is a digital-goods marketplace
whose order page carries a status banner ("Escalating — wait for platform
ruling"), a "View dispute" link, and a dispute detail page that reads as one
ordered timeline: *the buyer raised it → the seller answered → the buyer
rejected that answer → the platform rules*. Buyers already recognise that
shape, so the platform states plainly whose move it is and what happens next.

---

## 1. What a dispute is, and what it is not

| | Buyer dispute | Gateway chargeback | Support case |
|---|---|---|---|
| Who raises it | the buyer | the card issuer | anybody |
| What it contests | the delivery of a session | the authorisation of a payment | anything at all |
| Who answers | the expert (or the host organisation), then the platform | the platform files evidence with the network | an operator |
| Deadline | the respondent's three business days, then the platform's | the gateway's `respond_by` | the case SLA |
| Model | `PurchaseDispute` | `Dispute` | `SupportCase` |

A buyer dispute is **always a support case first**. The case carries the
conversation, the SLA, the audit trail, the evidence and the verdict; the
dispute is the *protocol* on top of it. So `PurchaseDispute` is a 1:1 child of
`SupportCase` and holds only what the protocol needs:

- who must answer (the respondent), and which kind of respondent they are;
- which round of the protocol this is;
- the respondent's answer, and whether they accepted the buyer's claim;
- the buyer's answer to that answer;
- where a refund would go, and the buyer's consent to that.

It deliberately holds **no money amount of its own beyond the amount at
stake when the claim was raised**. The money disposition lives on the case's
own model — `SupportCaseDecision` for the verdict and
`SupportFinancialRecommendation` for the refund — so a dispute can never
disagree with the ledger about a rupee.

## 2. The protocol

```
                     ┌──────────────────────────────────────────┐
                     │                                          │
  buyer claims       ▼            respondent answers           │
  ───────────►  OPEN ──────────────────────────────►  RESPONDED
                 │  │                                    │   │
   deadline      │  │ respondent ACCEPTS the refund        │   │ buyer ACCEPTS the rejection
   sweep ────────┘  │ (→ a refund recommendation is created)│   └──────────────► RESOLVED (no money)
                    │                                     │
                    │                                     │ buyer REJECTS the rejection
                    │                                     ▼
                    │                                  ESCALATED
                    │                                     │
                    │                                     │ platform decides
                    ▼                                     ▼
                 ESCALATED ◄─────────────────────────── UNDER_REVIEW
                    │                                     │
                    └────────────► RESOLVED ◄────────────┘
                                   (the money disposition is on the
                                    decision + recommendation)

  any open state ── buyer withdraws ──► WITHDRAWN
```

The rule that is not obvious: **`RESPONDED` means the respondent has
answered, not that the buyer has agreed.** Which way it went is
`respondentAcceptedRefund`:

- **accepted** → the platform executes the refund, then the dispute `RESOLVES`.
- **rejected** → the buyer may accept (no money moves, `RESOLVED`) or reject
  (`ESCALATED`, the platform rules).

The legal anchor is Consumer Protection Act 2019 s.2(8): a *"consumer dispute"*
only exists **once the seller denies the complaint**. So the statutory
redressal clock starts at the rejection, not at the claim — see
[§4](#4-the-clocks).

## 3. The money path

The respondent's acceptance does **not** move money. It creates a
`SupportFinancialRecommendation`, and the admin's `REVIEW_REFUND` approval
executes it through the universal refund front door:

```ts
refundBookingPayment({
  paymentId,
  amountPaise,
  reason,
  initiatedByUserId: actor.userId,
  dedupeKey: `case-recommendation:${recommendation.id}`,
  supportRecommendationId: recommendation.id,
});
```

**The dispute path never calls the gateway directly.** `refundBookingPayment`
is the only refund door, and it is where the live-chargeback re-check lives
inside its Serializable reservation — so a Razorpay chargeback landing
mid-dispute aborts the refund instead of double-debiting. See
[docs/payments/refunds-disputes/](../payments/refunds-disputes/).

Three database-level guarantees make "at most one refund" true rather than
merely intended:

| Guarantee | Mechanism |
|---|---|
| One refund per recommendation | `SupportFinancialRecommendation.refundId @unique` |
| One refund per logical action | `Refund.dedupeKey @unique` = `case-recommendation:<id>` |
| One live dispute per payment | partial unique index `purchase_dispute_open_payment_key` |

### The refund method

RBI's Payment Aggregator guidelines (§12.4) require a refund to go to the
original method of payment **unless the customer specifically agrees
otherwise**. So:

- `ORIGINAL_METHOD` is the default and the only one the platform may choose.
- `PLATFORM_CREDITS` requires the buyer's recorded agreement. The consent
  stamp is written by the protocol action, and a sidecar `CHECK` refuses a
  credits refund without it:

  ```sql
  CHECK ("refundMethod" IS DISTINCT FROM 'PLATFORM_CREDITS'
         OR "refundMethodConsentedAt" IS NOT NULL)
  ```

## 4. The clocks

Three clocks, and they are not the same clock.

| Clock | Window | Source |
|---|---|---|
| The **complaint** clock | acknowledge within 48 h, redress within one month | CP (E-Commerce) Rules 2020 r.4(4)–(5) |
| The **respondent** clock | three business days, in IST | our contractual promise |
| The **consumer-dispute** clock | starts at the respondent's **rejection** | CP Act 2019 s.2(8) |

Business days skip Saturday and Sunday in IST, because a deadline that lands
on a Sunday is not a deadline anybody can meet, and the time of day is
preserved so a claim filed at 18:00 is due at 18:00 three business days
later.

The respondent's window is swept by `runDisputeSweep`
(`lib/support/disputes/sweep.ts`, registered as `dispute-window-sweep` in
`lib/cron/cleanup-registry.ts`). The sweep also flags a claim approaching
its statutory redressal deadline, so a case about to breach the one-month
window is visible to the platform **before** it breaches.

## 5. Concurrency

Four layers, each closing a different failure mode. All four are in the
protocol, not bolted on afterwards.

### 5.1 The protocol CAS

Every transition is a conditional update whose `WHERE` carries the expected
status **and** the expected version:

```ts
const moved = await tx.purchaseDispute.updateMany({
  where: { id: disputeId, status: dispute.status, version: input.expectedVersion },
  data: { status: toStatus, version: { increment: 1 }, /* … */ },
});
if (moved.count === 0) throw new DisputeActionError("CONFLICT", "…", 409);
```

`version` is deliberately **not** `updatedAt`: the case's `updatedAt` also
moves when a message is appended, so an unrelated message would read as a
protocol conflict and the operator would be told to retry a move that had
already happened.

### 5.2 The idempotency replay

Every action carries a caller-minted `clientActionId`, and
`PurchaseDisputeAction` is unique on `(disputeId, clientActionId)`. So a
double-click, a retried request, or a replayed webhook is **one**
transition. The same key with a different body is refused rather than
replayed.

### 5.3 The money uniqueness

The database, not the application, is what makes "at most one refund" true
(§3). The application adds the `expectedRefundablePaise` preview-drift
guard, so an operator who read a stale refundable balance is told to re-read
rather than being allowed to over-refund.

### 5.4 The advisory-lock claim

The staff queue claims a case with a **Postgres** transaction-scoped advisory
lock — not a Redis lock, because this repo reserves Redis for request rate
limiting and short-lived interactive mutexes:

```ts
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${caseId}))`;
```

Transaction-scoped means the lock is released automatically at commit: no
orphaned locks, no table bloat.

### The races, and what closes each

| Race | Closed by | The loser sees |
|---|---|---|
| The buyer rejects the seller's acceptance while an operator refunds | the `REVIEW_REFUND` action re-reads the dispute's version inside the transaction | `409 DISPUTE_MOVED` with the current state |
| Two operators refund the same dispute | the recommendation's `decidedAt` CAS + `refundId @unique` + `Refund.dedupeKey @unique` | `409 ALREADY_DECIDED` with who won and when |
| A chargeback lands while a dispute refund is in flight | the refund goes through `refundBookingPayment`, whose Serializable reservation re-checks for a live dispute | the SSI abort retries, and the chargeback path wins |
| The seller accepts while the buyer escalates | both are `{ id, status, version }` conditional updates | `409 CONFLICT` with the current state |
| The deadline sweep escalates while the seller answers | the sweep's CAS is `{ status: "OPEN", respondentDueAt < now }` | the seller wins, the sweep no-ops |
| Two holds land on one payment | partial unique index `support_payment_hold_live_key` | `P2002` → the existing hold is returned |

The **global lock order** is `dispute → case → payment → refund → earnings
→ ledger`, so no two doors can deadlock.

## 6. Scope and authority

Two axes, and the rule is one line: **an actor may perform a capability on a
case only if the matrix grants them that capability for the case's scope,
and the scope permits that tier to act on it. Scope never grants capability;
capability never overrides scope.**

The **scope** is a property of the ROW, not of the user — which is why the
matrix does not explode into a role-per-case-type table:

| Scope | When |
|---|---|
| `counterparty-org` | two organisations on the same payment |
| `platform-money` | the platform's escrow or the ledger is at stake (this includes every personal payment) |
| `org` | an organisation's own service quality: no money, no counterparty |
| `individual` | one person's case, no organisation involved |

And what each tier may do at each scope:

| | Platform staff | Platform admin | Org admin | Org member |
|---|---|---|---|---|
| `org` | R I D | R I D X | R I D | R |
| `individual` | R I | R I D X | — | R |
| `platform-money` | R I | R I D X | **R only** | — |
| `counterparty-org` | R I | R I D X | **R only (own side)** | — |

Two rows carry the whole design:

1. **Money acts are platform-only at every scope.** An organisation may
   decide its own service quality, respond as the counterparty, and
   *request* a refund — never *execute* one. Its money sits in the
   **platform's** escrow, so it is not the holder of the funds it would be
   releasing. `refunds.manage` is a `BackofficeSurface`, and an
   `OrgSurface` is a different axis, so the separation is structural rather
   than a special case.
2. **`counterparty-org` is read-only for both organisations.** The party that
   benefits from the outcome must never be the party that decides it.

## 7. The surfaces

| Surface | Route |
|---|---|
| The buyer's claims | `/dashboard/consultee/[consulteeId]/disputes` |
| One claim | `/dashboard/consultee/[consulteeId]/disputes/[referenceNumber]` |
| The claim banner on the payment | `/dashboard/consultee/[consulteeId]/payments/[paymentId]` |
| The expert's claims to answer | `/dashboard/consultant/[consultantId]/disputes` |
| One claim (respondent side) | `/dashboard/consultant/[consultantId]/disputes/[referenceNumber]` |
| The platform's queue | `/dashboard/[admin\|staff]/money/disputes` → *Buyer disputes* |
| The API | `/api/purchases/disputes`, `/api/purchases/disputes/[referenceNumber]`, `/api/purchases/disputes/[referenceNumber]/actions` |

A dispute reference is `DSP-YYYY-NNNNNN`, derived from its case's
`FAM-YYYY-NNNNNN` by swapping the prefix — so the two identifiers line up,
and the buyer can say "my case is FAM-2026-000123" while the agent says
"your dispute is DSP-2026-000123".

## 8. Source code map

| File | Responsibility |
|---|---|
| `lib/support/disputes/protocol.ts` | The state machine, the legal-transition guard, the buyer-facing wording |
| `lib/support/disputes/actions.ts` | The protocol actions: the CAS, the idempotency replay, the authorisation |
| `lib/support/disputes/raise.ts` | Raising a claim — the case and the protocol created in one Serializable transaction |
| `lib/support/disputes/respondent.ts` | Who must answer: the host organisation, else the delivering consultant |
| `lib/support/disputes/scope.ts` | The scope resolver and the scope × capability matrix |
| `lib/support/disputes/deadlines.ts` | The three clocks, and the IST business-day arithmetic |
| `lib/support/disputes/sweep.ts` | The missed-window escalation and the at-risk statutory flag |
| `lib/support/disputes/reference.ts` | The `DSP-` reference, derived from the case reference |
| `components/support/DisputeBanner.tsx` | The buyer's banner on the payment page |
| `components/support/DisputeTimeline.tsx` | The dispute timeline and the actions either party can take |
| `components/dashboard/backoffice/money/BuyerDisputesPanel.tsx` | The platform's queue |
| `app/api/purchases/disputes/**` | The buyer and respondent API |
| `app/api/admin/buyer-disputes/route.ts` | The platform's read |

## 9. Related

- [02-the-grid.md](02-the-grid.md) — the cross-entity ownership model this
  protocol sits inside.
- [03-ticket-references-and-sla.md](03-ticket-references-and-sla.md) — the
  case SLA and the reference allocator.
- [07-ticket-lifecycle-and-concurrency.md](07-ticket-lifecycle-and-concurrency.md)
  — the case's own concurrency contract.
- [../compliance/10-consumer-protection-and-grievance.md](../compliance/10-consumer-protection-and-grievance.md)
  — the statutory obligations the clocks implement.
- [../payments/refunds-disputes/](../payments/refunds-disputes/) — the
  refund and gateway-chargeback machinery.
