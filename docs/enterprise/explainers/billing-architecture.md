# Architecture 4 — Billing & Capability Explainer

> **Audience:** a junior developer who doesn't know this codebase yet and wants to stop being confused about capabilities, funding sources, payouts, the "Amazon teaches itself" case, and what happened to the old vocabulary.
>
> **Tone:** concrete, worked examples, no compliance jargon. Skipping TDS, SSO, SAML, ACS — those are separate problems for someone else.
>
> **How to read this:** top-down. Each section assumes you've read the ones before it.

---

## 1. The TL;DR you can hold in your head

Architecture 4 replaced the old "one Organization = one kind" world with **two independent booleans** on every org:

```
Organization.canSponsor  // "This org can pay for sessions its members book"
Organization.canHost     // "This org can employ experts who deliver sessions"
```

These two booleans give you **four capability kinds**:

| Kind    | `canSponsor` | `canHost` | Intuition                                      |
| ------- | ------------ | --------- | ---------------------------------------------- |
| SPONSOR | ✅            | ❌         | A company that *buys* mentorship for its team. |
| HOST    | ❌            | ✅         | An agency whose experts *sell* mentorship.     |
| HYBRID  | ✅            | ✅         | Does both — internal AND external flow.        |
| INERT   | ❌            | ❌         | Transitional/broken; org exists but can't act. |

Orthogonal to that, a SPONSOR or HYBRID org picks **one funding source** — how it pays for the sessions its members book:

| Funding source | One-liner                                                                              |
| -------------- | -------------------------------------------------------------------------------------- |
| **PERSONAL**   | Members swipe their own card. Org is just a tag for reporting.                         |
| **WALLET**     | Org pre-loads a credit pool. Bookings deduct from it in real time.                     |
| **INVOICE**    | Members book freely. Org gets one bill at the end of the month, pays NET-30 / NET-60. |
| **LICENSE**    | Org pays a flat fee up front. Bookings are unmetered inside the contract.              |

That's the whole mental model. Everything else — the ledger rows, the payout flow, the Razorpay webhooks — exists to implement these four patterns correctly.

File refs for this section: `lib/labels/org-labels.ts:29-85`, `prisma/schema.prisma:756-762` (FundingSource enum).

---

## 2. Why two axes instead of one enum?

The old world (Arch 1–3) had a single `OrganizationKind` enum — `PROVIDER / BUYER / HYBRID / …`. That collapsed two independent decisions into one slot and produced broken states (a "PROVIDER" that also wanted to buy seats for its own staff, etc).

Arch 4 flips that: **capability is two booleans, funding is a separate enum.** Any org can independently answer "do we give money?" and "do we take money?" without being locked into a one-shape fits-all kind. The `CapabilityKind` we still use (`SPONSOR`/`HOST`/`HYBRID`/`INERT`) is *derived* from the booleans, not stored — see `deriveCapabilityKind()` at `lib/labels/org-labels.ts:29-37`. It exists purely for UI labels and badges.

**The word "provider" is gone from product vocabulary.** It still appears in a handful of internal variable names (`resolveOrgSplit`, `ENABLE_PROVIDER_ORGS` flag in `lib/payments/payouts/earnings-service.ts:110`) but no user-facing surface says "provider" anymore. Treat any remaining use as technical debt — grep and rename when you touch it.

---

## 3. The 3×4 matrix — what combinations actually exist

You sometimes hear "nine permutations" (3 kinds × 3 relevant modes). Here's the real table — note that HOST and INERT don't fund anything, so they have no funding source at all:

| Capability ↓ / Funding →   | PERSONAL | WALLET | INVOICE | LICENSE |
| -------------------------- | -------- | ------ | ------- | ------- |
| **SPONSOR** (buy-only)     | ✅        | ✅      | ✅       | ✅       |
| **HOST** (sell-only)       | —        | —      | —       | —       |
| **HYBRID** (buy + sell)    | ✅        | ✅      | ✅       | ✅       |
| **INERT** (neither)        | —        | —      | —       | —       |

So you have **8 live cells** (2 capability rows × 4 funding columns), not 12. HOST and INERT orgs never even get a `BillingAccount` row — look at `app/api/organizations/route.ts:204-220`, billing account creation is gated on `body.canSponsor`.

A HYBRID org has a BillingAccount for the sponsor side *and* a PayoutAccount for the host side. Two completely independent money rails in one org.

**Validation fence** (`app/api/organizations/route.ts:70-98`): org creation requires `canSponsor || canHost` to be true — INERT orgs can't be created through the API. An INERT row only exists if someone nukes both capabilities via direct DB edit (which our UI doesn't expose).

---

## 4. Who are the four parties in every booking?

Before we go mode by mode, let's name the roles that show up in every money story:

- **The learner** — the human who consumes the session.
- **The consultant / expert** — the human who delivers the session.
- **The sponsor org** (optional) — the entity paying on the learner's behalf (if funding isn't PERSONAL).
- **The host org** (optional) — the entity the consultant belongs to.
- **Familiarise** — the platform, always takes a fee.

For a B2C booking (no orgs involved), you get `Learner pays → Platform takes fee → Consultant keeps the rest`. One-line, easy.

For an enterprise booking, you add a sponsor and sometimes a host. The **settlement ledger** records who owes whom, so nothing ever gets lost between "learner clicked Pay" and "consultant received money on Friday".

Core tables (`prisma/schema.prisma`):
- `Payment` — the charge itself (what the gateway saw).
- `ConsultantEarnings` — "this consultant is owed X, status PENDING/PAID".
- `OrganizationEarnings` — "this host org is owed X, status PENDING/PAID".
- `SettlementLedgerEntry` — audit row for every money event (CREDIT, INVOICE_ISSUED, INVOICE_PAID, …).
- `WalletEntry`, `FundingLedgerEntry` — wallet balance deltas.
- `Payout`, `OrganizationPayout` — the outbound transfer.

You don't need to memorise the table names. Just remember: **money never disappears; every movement writes a row somewhere.**

---

## 5. Funding mode walk-throughs

Each mode is basically a different answer to one question: *"At checkout, who pays?"*

### 5.1 PERSONAL — members pay themselves

This is just B2C billing with an org tag. Org gets nothing, owes nothing.

```
Learner clicks Pay
   ↓
Razorpay charges learner's card (₹1000)
   ↓
Webhook fires → Payment SUCCEEDED
   ↓
ConsultantEarnings row: consultant is owed ₹800 (platform keeps ₹200)
   ↓
Payout cron sends ₹800 to consultant later in the week.
```

The `BillingAccount` exists but `walletBalance` stays null. No `OrganizationEarnings` is created because org isn't in the money path — it's just a reporting tag. Useful when a company wants visibility into what its team spends on mentorship, even if the company doesn't pay directly.

### 5.2 WALLET — prepaid credit pool

Org tops up their wallet ahead of time, members book freely, each booking atomically debits.

```
1. Org OWNER goes to /credits, clicks "Top up ₹50,000".
   Razorpay charges the org's card.
   Webhook fires → wallet.balance += 50000 paise; WalletEntry(TOPUP) row written.

2. LEARNER member books a ₹1000 session.
   Inside the checkout transaction:
     UPDATE BillingAccount SET walletBalance -= 1000
       WHERE id = ... AND walletBalance >= 1000
   If balance was enough → booking confirmed, WalletEntry(BOOKING, -1000) written.
   If not → SQL returns 0 rows → checkout rolls back → HTTP 402 to learner.

3. Consultant gets paid from platform's collected-but-not-yet-paid bucket —
   same ConsultantEarnings → Payout flow as PERSONAL.
```

The atomic UPDATE is the whole concurrency model (`lib/api/organizations/wallet.ts:51-113`). Two members booking simultaneously can't over-draw; Postgres row-locks one until the other commits.

**What you never do:** you never "spend from the wallet, then check later" — always the conditional SQL UPDATE. If you forget and write `if (balance >= x) { update; debit }` as two statements, you've introduced a race.

### 5.3 INVOICE — book now, bill later

Members book as if it's free. At the end of the billing cycle, a cron generates one `OrganizationInvoice` for the org to pay via NET-30 / NET-60 terms.

```
Throughout the month:
   Member books a session
   → PaymentLeg(source=INVOICE_ACCRUAL, amountPaise=1000) written.
   → Booking confirmed immediately. Learner sees no payment step.

End of cycle (cron at jobs/billing/generate-subscription-invoices.ts):
   SELECT all BillingSubscription rows with nextInvoiceDate <= now
   For each:
     amount = sum(accruals this cycle) or flatFee or ratePerSeat × seats
     Create OrganizationInvoice with GST breakdown
     Write SettlementLedgerEntry(kind=INVOICE_ISSUED)
     advance nextInvoiceDate by one cycle

When org pays the invoice (manual via /billing UI or Razorpay):
   Webhook or admin action → status=PAID
   SettlementLedgerEntry(kind=INVOICE_PAID) written.
```

The cron is the trick. Three important details:

1. **Distributed-lock idempotence**: the cron uses a conditional `updateMany` on `nextInvoiceDate <= now` to atomically claim a subscription, so running the cron twice by accident produces one invoice, not two.
2. **Accruals vs. flat fees vs. seat count**: `BillingSubscription.model` can be `FLAT_FEE` (constant every month), `PER_SEAT` (multiplies by active members), or plain accrual-based. See `jobs/billing/generate-subscription-invoices.ts:58-61`.
3. **Consultants get paid immediately, not when the invoice is paid.** `ConsultantEarnings` rows go to PENDING the moment the booking happens. Platform floats the money. When the invoice is eventually paid, that's a separate ledger entry reconciling the float — not a trigger for the payout.

### 5.4 LICENSE — pay once, unmetered thereafter

The org pays a flat annual / quarterly contract fee (offline or via Razorpay) and then bookings are free to members throughout the period.

```
Contract signed out of band.
BillingSubscription created with model=FLAT_FEE, amount=contractValue.

Member books a session (any amount):
   PaymentLeg(source=LICENSE, amountPaise=0)
   BookingUtilization +1 (tracked for analytics, not billing)
   Consultant still gets their share from the platform float.

At each invoice cycle:
   Cron issues OrganizationInvoice for the next period's license fee,
   not for any per-session amounts.
```

The "unmetered" part means the per-session charge to the *org* is zero. The consultant payout is **not** zero — platform still pays the consultant from the license fee pool. Think of a LICENSE org as prepaying a big batch of sessions and then not caring about individual booking amounts.

Program-level schema exists for limited-vs-unlimited: `LicensedSeat.coveredEngagementsPerCycle = null` means unlimited, or a number means a cap (when the cap is hit, bookings revert to PERSONAL-style charging). Most enterprise LICENSE contracts are unlimited because the entire point is "stop counting".

---

## 6. HYBRID and the Amazon self-dealing puzzle

This is the bit that melts new developers' brains, so let's walk it carefully.

### The setup

Amazon is a HYBRID org:
- `canSponsor = true` (they pay for sessions their juniors book)
- `canHost = true` (they employ senior devs who deliver those sessions)

Senior dev A is an EXPERT member of Amazon. Junior dev J is a LEARNER member of Amazon. J books a 1-hour session with A.

**Naive question:** isn't Amazon paying itself? Why is money moving?

### What the code actually does

The settlement pipeline does **not** detect "same org on both sides" and short-circuit the flow. Every booking runs through `resolveOrgSplit()` at `lib/payments/payouts/earnings-service.ts:99-184` the same way:

1. `Payment` is captured (however — WALLET debit, INVOICE accrual, or PERSONAL card charge — doesn't matter here).
2. `ConsultantEarnings` is written with consultant A's share.
3. `OrganizationEarnings` is written with Amazon's share.

So from the ledger's view, there are two mechanical money flows even when both parties sit inside Amazon:

- **Sponsor side (inbound):** Amazon's BillingAccount is drained (wallet debit, invoice accrual, etc.).
- **Host side (outbound):** Amazon's PayoutAccount receives a payout.

### Why that's actually correct

Two reasons the code doesn't short-circuit:

1. **Amazon's sponsor budget and Amazon's host revenue are different P&L buckets.** The L&D team has a spending cap; the consulting-services team has a revenue target. An internal session shows up as spend on one ledger and revenue on another. Collapsing them would *hide* the value flow from both teams' reports.

2. **Platform still takes its fee.** Familiarise's platform cut is the one thing that's unambiguously real money leaving Amazon, regardless of internal structure. The ledger has to record that fee was charged — and you can only record it if the money flow is modelled.

So yes: **on a same-org HYBRID booking, Amazon both pays and receives, and pays Familiarise a platform fee in the middle.** From Amazon's consolidated view, that fee is the only net outflow. The rest nets to zero — but the two sides of the zero are both recorded.

### The "`payoutRecipient`" knob

There's an important escape hatch. Each `Membership` row has a `payoutRecipient` column:

```prisma
enum PayoutRecipient {
  SELF          // consultant keeps their share personally
  ORGANIZATION  // host org keeps the consultant's share
}
```

When `payoutRecipient = ORGANIZATION` (the Amazon case almost always), `resolveOrgSplit` routes things differently (`earnings-service.ts:155-162`):

```ts
if (payoutRecipient === "ORGANIZATION") {
  return {
    platformFee,
    orgShare: grossAmount - platformFee,  // org keeps everything after platform
    consultantShare: 0,                    // consultant gets paid by org, not by us
  };
}
```

So in the Amazon flow, consultant A's personal payout is zero — Amazon pays A through Amazon's own payroll, not through Familiarise. The ledger shows: Amazon paid ₹1000, Familiarise kept ₹200, Amazon's host side got ₹800 back. Net: Amazon spent ₹200 to use Familiarise's platform for an internal session.

For marketplace HYBRIDs (e.g. a coaching agency that employs some experts but lets freelancers use the platform too), different experts can have different `payoutRecipient` values. Salaried staff → ORGANIZATION, freelancers → SELF.

### Who sets the price?

Always the consultant (via `ConsultationPlan.rate` or `SubscriptionPlan.rate`), but the org can override for its experts via `RateCard.rateCardOverrideId` on the Membership (`prisma/schema.prisma:628-629`). So in practice:

- Freelancer marketplace: the expert sets rates directly on their plans.
- HOST org: the org publishes a `RateCard` and all experts use it.
- HYBRID with internal-only experts: the org sets a standard internal rate; consultants can't undercut.

This is why the design keeps `payoutRecipient` on `Membership` (not `ConsultantProfile`) — the same human can be a freelancer to their own clients *and* a salaried expert inside Amazon, with different rates and different payout destinations.

---

## 7. Payouts — how money actually leaves the platform

> "If we are paying out, how will we pay out? Will Razorpay and Stripe take care of the whole thing?"

**Short answer:** yes, but we drive them. The platform doesn't just drop a row and wait — it actively calls the gateway's payout API.

### The lifecycle (`lib/payments/payouts/payout-service.ts:80-863`)

```
PENDING  ─► APPROVED  ─► PROCESSING  ─► COMPLETED (or FAILED / CANCELLED)
```

1. **PENDING → APPROVED.** When `createPayoutBatch` runs, each payout either auto-approves (if amount < threshold) or sits in PENDING waiting for a human admin to click Approve in `/dashboard/admin/payouts`.

2. **APPROVED → PROCESSING.** The `processApprovedPayouts` job fetches approved rows, calculates TDS (for Indian consultants), and calls the actual gateway:
   - **Razorpay** (domestic INR consultants) → `razorpay.payouts.create(fundAccountId, amount, …)` via RazorpayX.
   - **Stripe** (international consultants) → `stripe.transfers.create(…)` to a connected account.

   The call is synchronous-ish: we get a gateway payout ID back and store it; the row is now PROCESSING.

3. **PROCESSING → COMPLETED.** A webhook from the gateway tells us the transfer landed. We then:
   - Flip `ConsultantEarnings.payoutStatus = PAID` for every earnings row linked to the payout.
   - Write TDS records (for India), update `consultant.pendingRevenue`.
   - Decrement the PSP's outstanding-balance number.

   If the webhook says FAILED (insufficient funds at gateway, bank rejected, etc.), we unlink the earnings (payoutId → null) and the next cron cycle will retry them.

### Two pipelines, not one

- `Payout` rows pay **individual consultants** (when `payoutRecipient=SELF`).
- `OrganizationPayout` rows pay **host orgs** (when `payoutRecipient=ORGANIZATION` or when an org earned from its own freelancer members).

The two pipelines share ~80% of the code path but have separate tables so they can have separate SLAs, audit trails, and approval thresholds. Ops people care about which org got paid when; consultants care about their personal payment status. Don't try to unify them — you'd have to re-split everything downstream.

### What you should *not* worry about as a junior

- **TDS calculations** (Section 194J of Indian income tax). Handled in `processSinglePayout` at `payout-service.ts:512-535`. Just know TDS is withheld before the transfer goes out.
- **IRN / e-invoicing**. `OrganizationInvoice.irnStatus = PENDING` until the (stubbed) uploader cron talks to the IRP. You can generate invoices and ignore IRN until the invoice actually needs to be submitted to the government.
- **SSO / SAML / OIDC / ACS**. Entirely decoupled from billing. An SSO-enforced domain just gates *sign-in*; once the user is in, everything else works the same.

---

## 8. Dashboards — what each persona sees

> "When enterprise consultants and consultees (aka experts and learners) will they be able to see the same thing on the consultant and consultee dashboard, or do we have to create new dashboards?"

### Current state

There's **one** consultant dashboard (`/dashboard/consultant/[id]/...`) and **one** consultee dashboard (`/dashboard/consultee/[id]/...`) per user. An EXPERT in Amazon uses the exact same UI as a freelance consultant; a LEARNER in Amazon uses the same UI as a B2C learner. Their booking lists, earnings (consultant side), and payment history (consultee side) are merged across all contexts — personal bookings and org-sponsored bookings in the same table.

Org context is surfaced separately:

- **OrganizationSwitcher** (`components/dashboard/OrganizationSwitcher.tsx`) in the sidebar lets the user jump to `/dashboard/organization/[orgId]/home` for org-specific views (members, billing, earnings **for this org**, payouts **for this org**).
- **OrgContextBar** at the top of every org page shows which org you're in, capability badges, and a "← Personal" link back to the personal dashboard.

So conceptually: **one personal identity per user, multiple org memberships, each with its own org-scoped dashboard.** The personal dashboard is the union of everything; the org dashboard is the filtered view.

### Should there be role-filtered personal dashboards?

You mentioned you created an issue for a "separate dashboards + org switcher to filter" approach. That's tricky: splitting the personal dashboard into context-filtered views means someone booking a personal session and a sponsored session would see them in different places. Users who are *both* a consultee in Amazon and a consultee B2C would have to mentally decide which list to open. Consolidating (current state) means one "Upcoming sessions" list with a capability badge next to each row, and you can filter client-side.

My read: keep the personal dashboard consolidated, keep the org dashboard separate, and add a "Source" column / filter chip on the personal dashboard rather than splitting it. But your judgment — ship the filtered approach if user testing shows confusion.

What the new `OrgAdminProfile` unlocks is a third dashboard specifically for org *operators* (OWNER / MAINTAINER who are not consumers or experts). Today `/dashboard/org-admin/[id]` is minimal — auto-redirects single-org owners into their org home, shows a chooser for multi-org. Future: operator-only preferences (notification defaults, pinned orgs, cross-org reporting).

---

## 9. What happened to the old vocabulary

### "Provider"

Gone from UI. Still present as `resolveOrgSplit` / `ENABLE_PROVIDER_ORGS` feature flag in settlement code. Not exposed to users. Treat as legacy naming.

### "Three-way split"

Still alive — it's the **current** revenue model, just not called "the kind" anymore:

```
Gross booking amount
  ├── Platform fee (Familiarise takes)
  ├── Organization share (if canHost, goes to host org)
  └── Consultant share (if payoutRecipient=SELF) OR absorbed into org share (if ORGANIZATION)
```

The split percentages live in `RateCard` rows attached to the host org — they're the contract terms between platform, org, and consultant. A freelance consultant (no host org) gets a 2-way split: platform fee + consultant share.

### The old 4-5 "billing modes"

If you find docs that list e.g. `CREDIT_POOL / INVOICE / LICENSE / PROJECT / RETAINER`, those are pre-refactor names. Mapping:

- `CREDIT_POOL` → `WALLET`
- `PROJECT` → still exists as an enum value but is reserved for v2 and intentionally not self-service
- `RETAINER` → never shipped; folded into LICENSE

Don't use old names in new code or docs. `FundingSource` enum is the source of truth (`schema.prisma:756-762`).

---

## 10. Worked examples — the full story, four ways

### Example A: Solo learner books a solo freelancer (zero orgs)

```
L (learner) books 1h with C (consultant) for ₹1000.
  ├── Razorpay captures ₹1000 from L's card
  ├── Payment(SUCCEEDED) row written
  ├── ConsultantEarnings(C, ₹800, PENDING)
  ├── Platform retains ₹200
  ├── [days later] Payout job pays C ₹800 via Razorpay/Stripe
  └── ConsultantEarnings status → PAID
```

### Example B: SPONSOR org with WALLET funds a learner's session

```
Month-start: Acme tops up wallet by ₹50,000.
  ├── Razorpay charges Acme, WalletEntry(TOPUP, +50000) written.
Later: Alice (LEARNER at Acme) books C (external freelancer) for ₹1000.
  ├── Checkout tx: UPDATE walletBalance -= 1000 atomically
  ├── WalletEntry(BOOKING, -1000), FundingLedgerEntry(BOOKING_DEBIT)
  ├── ConsultantEarnings(C, ₹800, PENDING)  [platform keeps ₹200]
  └── Payout later: C gets ₹800 from platform
Acme sees ₹1000 drop from wallet, gets a line in their consolidated statement.
```

### Example C: HYBRID Amazon, internal senior dev teaches internal junior

Assumes `payoutRecipient = ORGANIZATION` on the senior dev's Amazon Membership.

```
J (LEARNER at Amazon) books A (EXPERT at Amazon) for ₹1000. Funding = INVOICE.
  ├── PaymentLeg(INVOICE_ACCRUAL, 1000) written
  ├── Booking confirmed (J pays nothing at checkout)
  ├── ConsultantEarnings(A, ₹0, PENDING)       [absorbed into org]
  ├── OrganizationEarnings(Amazon, ₹800, PENDING)  [consultant share routed to org]
  ├── Platform retains ₹200
End of cycle:
  ├── Invoice cron writes OrganizationInvoice for Amazon's accruals (includes the ₹1000 line)
  ├── SettlementLedgerEntry(INVOICE_ISSUED)
Amazon pays the invoice via NET-60:
  ├── SettlementLedgerEntry(INVOICE_PAID)
Next payout cycle:
  ├── OrganizationPayout sends ₹800 to Amazon's host-side PayoutAccount
  └── Amazon pays A via internal payroll (off-platform)
Net from Amazon's view: ₹200 left the company (platform fee). Rest netted out.
```

### Example D: HOST-only coaching agency sends freelancers to external learners

```
CoachCorp (HOST) has 5 EXPERT freelancers. No BillingAccount.
Random learner L books coach Bob (EXPERT at CoachCorp, payoutRecipient=SELF) for ₹1000.
  ├── Razorpay charges L
  ├── ConsultantEarnings(Bob, ₹720, PENDING)   [coach's personal share]
  ├── OrganizationEarnings(CoachCorp, ₹80, PENDING)  [agency's rate-card cut]
  ├── Platform retains ₹200
Payouts go out on different cycles:
  ├── Bob gets ₹720 via his personal PayoutAccount
  └── CoachCorp gets ₹80 via its OrganizationPayoutAccount
```

Note the different split percentages in example B vs D — that's the `RateCard` row for CoachCorp defining "platform 20, agency 8, coach 72" vs the default B2C "platform 20, consultant 80". Edit the rate card, edit the split.

---

## 11. What to read next if you want to go deeper

- `docs/enterprise/06-expert-lifecycle.md` — how EXPERTs enter an org (invite / direct add) and why LEARNER↔EXPERT is disjoint.
- `docs/enterprise/playbooks/billing-technical.md` — the 3×4 matrix in more code-level detail; the canonical reference.
- `docs/finances/11-cfo-master-plan.md` — the commission/tier strategy story (why 10% launch → 15-20% later).
- `docs/payments/payouts/01-architecture.md` — payout state machine diagrams.

And if you only remember three things from this entire doc:

1. **Capability is two booleans (canSponsor, canHost); funding is one enum. They combine, they don't fight.**
2. **Money always flows through the ledger — even when both parties are in the same HYBRID org — so the platform fee gets recorded and each side's P&L reflects reality.** `payoutRecipient=ORGANIZATION` is the knob that says "consultant's share stays in the org, not in the human's pocket."
3. **Razorpay/Stripe send the money, but we drive the state machine.** Payouts go PENDING → APPROVED → PROCESSING → COMPLETED; each transition is our code, and the PSP webhook is the thing that completes it.
