# The back-office case console

The console is the platform's operating surface: where a support case, a
buyer dispute, a gateway chargeback, a moderation report, a refund and a
payout are read, worked and closed. This document is the map of it — what
each queue is, who may act on it, and what the money surfaces show.

It is the operator's counterpart to the buyer's dashboard: the buyer sees
their money, the console sees the platform's.

---

## 1. One tree, two audiences

`app/dashboard/(backoffice)/[tree]/` serves both audiences — `admin` and
`staff` — from one route tree, so a surface can never exist for one and not
the other. The difference between them is expressed in exactly one place,
`lib/auth/backoffice-permissions.ts`:

> STAFF own support end-to-end: tickets, feedback, moderation, appointments
> and user verification. This is the job. STAFF READ every money surface,
> because a support agent who can't see a payment can't resolve a billing
> ticket. They mutate none of it. ADMIN alone executes money, owns org
> lifecycle and platform config, and takes the destructive user actions.

One matrix, three consumers — the sidebar (visibility), the page guard
(`requireBackofficePage`) and the API route (`requireBackofficeSurface`) —
so a surface can never drift into "tab shown, page redirects, API 403s".

## 2. The scope × capability model

The permission matrix answers *which act*. It does not answer *who may
decide*, and for anything touching money those are very different
questions: an organisation may raise a refund request against its own money
and may not release it.

So there are two axes. **CAPABILITY** is the act (`read` · `investigate` ·
`decide` · `execute`). **SCOPE** is which entity a case is *about* — a
property of the ROW, not of the user:

| Scope | When |
| --- | --- |
| `counterparty-org` | two organisations on the same payment |
| `platform-money` | the platform's escrow or the ledger is at stake |
| `org` | an organisation's own service quality: no money, no counterparty |
| `individual` | one person's case, no organisation involved |

The rule is one line: **an actor may perform a capability on a case only if
the matrix grants them that capability for the case's scope, and the scope
permits that tier to act on it. Scope never grants capability; capability
never overrides scope.**

The two rows that carry the design:

1. **Money acts are platform-only at every scope.** An organisation may
   decide its own service quality, respond as the counterparty, and
   *request* a refund — never *execute* one. Its money sits in the
   **platform's** escrow, so it is not the holder of the funds it would be
   releasing. `refunds.manage` is a `BackofficeSurface` and an `OrgSurface`
   is a different axis, so the separation is structural rather than a
   special case bolted on.
2. **`counterparty-org` is read-only for both organisations.** The party
   that benefits from the outcome must never be the party that decides it.

The implementation is `lib/support/disputes/scope.ts`; the full matrix is
in [../support/02-the-grid.md](../support/02-the-grid.md).

## 3. The queues

| Queue | Route | Surface | What it is |
| --- | --- | --- | --- |
| **Support inbox** | `/support` | `tickets.manage` | The merged case queue: every open case, whatever it is about |
| **Money** | `/money/<tab>` | per tab | Payments, refunds, disputes, payouts, earnings, reconcile, incidents, audit, and the overview |
| **Disputes** | `/money/disputes` | `disputes.read` | Gateway chargebacks **and** buyer disputes |
| **Moderation** | `/moderation` | `moderation.manage` | Abuse reports and the review queue |
| **Feedback** | `/feedback` | `feedback.manage` | Product feedback, with the staff note |
| **Money overview** | `/money/overview` | `payments.read` | The money in flight, at a glance |

### The support inbox

One table, ten columns, and every filter in the URL:

```
[✓] │ Reference │ Subject │ Topic │ Status │ Priority │ Assignee │ Amount │ SLA/age │ Last activity │ [⋯]
```

- The filters (`INBOX_FILTER_KEYS`) were always in the URL; the **FilterBar**
  is what finally makes them reachable.
- **Copy link to this view** shares the queue as a URL, because the URL
  already IS the view.
- The audit trail is **interleaved into the conversation column**, not
  buried in a collapsed panel in the side panel. Every comparable tool
  (Zendesk, Stripe Radar, Discord, Linear) puts the event stream in the
  centre column; the side panel keeps FACTS (person, booking, payment,
  organisation, past cases, attachments).
- **Bulk actions report per row.** Each affected case gets its own
  `OpsActionLog` row in the same transaction as the case write, and a
  REFUSED row still gets one carrying the refusal code — so a refusal is as
  auditable as a success, and "who refunded this payment" has an answer.
- The row is a real link, so Tab, Enter, middle-click and "open in new tab"
  all work.

### The buyer-dispute queue

The money console's disputes tab carries two things side by side, because
both are "money the platform is holding that somebody says it should not
be" — but they are different acts with different deadlines:

- a **gateway chargeback** has the gateway's `respond_by`;
- a **buyer dispute** has the respondent's three business days, and then the
  platform's.

The protocol itself is in [../support/10-buyer-disputes.md](../support/10-buyer-disputes.md).

## 4. The money overview

`/money/overview` is the money-in-flight page: what the platform holds,
what it owes, what it is at risk of losing, and what is broken.

| Row | Panels |
| --- | --- |
| 1 | GMV · Net revenue · Take rate · Refund rate · Dispute rate |
| 2 | Dispute aging (stacked bar) · Payout success + latency |
| 3 | T+N liability ladder · Reconciliation breaks |
| 4 | "Needs a human" money · Money at risk · Refund rate by reason code |

Five rules the page is built on:

1. **Every metric is defined in ONE place**, computed from a **named
   `where`** that is also used by its drill-through list, and **has a
   drill-through**. A number you cannot click through to the rows that made
   it is a number nobody trusts.
2. **Never a pie chart.** A sorted horizontal bar with counts *and*
   percentages. A pie is not comparable by length; a sorted bar is.
3. **Never a dual-axis combo.** GMV and net revenue are two lines with a
   shaded band; take rate is its own panel, not a second y-axis.
4. **`destructive` is reserved for actual loss or breach**, never for
   "needs attention". A queue where everything is red is a queue where
   nothing is.
5. **Status is never colour-only** (WCAG 1.4.1). Every tone carries a
   text label.

**Dispute rate is "dispute activity"** — disputes opened ÷ payments, by
DISPUTE DATE — because that is the calculation the card networks use. A
rate by charge date lags by up to 120 days and is the wrong number to
steer by.

**The T+N ladder** is the India-specific one: money collected today that
cannot be paid out until T+1 or T+7, with the statutory **TDS** and
**GST** liabilities and their due dates, because a statutory liability with
a deadline belongs on the money page rather than in a compliance tab.

**Reconciliation breaks** are a table, never a chart. Zero rows is the
normal state; a row is an incident.

## 5. The audit trail

Every console action writes exactly one `OpsActionLog` row: who, what role,
which surface, which action, on which row, **and why** — the reason is
mandatory and at least five characters. For a bulk action it is one row
per affected row, not one per batch.

The console's own log is at `/money/audit` (surface `opsLog.read`), and
staff read only their own rows.

## 6. Related

- [../support/01-architecture.md](../support/01-architecture.md) — the
  support case graph.
- [../support/10-buyer-disputes.md](../support/10-buyer-disputes.md) — the
  two-party adjudication protocol.
- [../support/02-the-grid.md](../support/02-the-grid.md) — the
  cross-entity ownership model.
- [../authorization/01-authorization-matrices.md](../authorization/01-authorization-matrices.md)
  — the three matrices in full.
- [../payments/backoffice/01-money-console.md](../payments/backoffice/01-money-console.md)
  — the money console's own history.
