# Collaborator System — Architecture & Flows

This document tells the story of how multi-creator collaboration works on Familiarise. It follows the journey from a host inviting a collaborator, through acceptance and coordination, to how revenue is split when a customer pays, and what happens during refunds. Each section builds on the last.

---

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [Inviting a Collaborator](#2-inviting-a-collaborator)
3. [Responding to an Invitation](#3-responding-to-an-invitation)
4. [Coordinating via Stream Chat](#4-coordinating-via-stream-chat)
5. [Scheduling with Availability Overlay](#5-scheduling-with-availability-overlay)
6. [How Revenue Gets Split on Payment](#6-how-revenue-gets-split-on-payment)
7. [Refund Cascade — Unwinding Multi-Party Earnings](#7-refund-cascade--unwinding-multi-party-earnings)
8. [Removing a Collaborator](#8-removing-a-collaborator)
9. [The Complete Lifecycle](#9-the-complete-lifecycle)

---

## 1. The Big Picture

Familiarise supports four service types: consultations, subscriptions, webinars, and classes. Consultations and subscriptions are inherently one-on-one — a single consultant works with a single consultee. But webinars and classes are group events, and in the real world, these are often team efforts. A React webinar might have a primary instructor and a co-host managing Q&A. A bootcamp class might have a lead teacher, a teaching assistant, and a guest lecturer for specific modules.

The collaborator system makes this possible. It sits on top of the existing plan/event architecture without changing how events are scheduled or how participants register. The key principle is: **the host owns the plan; collaborators participate on the host's terms**.

Here's the bird's-eye view of how a collaboration plays out:

```
  Consultant A (Host)                              Consultant B (Collaborator)
       │                                                    │
       │  1. Creates WebinarPlan                            │
       │     "Advanced React Patterns"                      │
       │     Price: ₹1,000                                  │
       │                                                    │
       │  2. Invites Consultant B                           │
       │     Role: CO_HOST                                  │
       │     Share: 25%                                     │
       │───────────────────────────────────────────────────>│
       │                                                    │
       │                                    3. Sees invite  │
       │                                       in dashboard │
       │                                                    │
       │                                    4. Accepts      │
       │  <─────────────────────────────────────────────────│
       │                                                    │
       │  5. Stream chat channel auto-created               │
       │     "Advanced React Patterns - Collaborators"      │
       │     Members: [A, B]                                │
       │                                                    │
       │  6. A schedules the webinar event                  │
       │     (host-only — B cannot schedule)                │
       │                                                    │
       │  7. User C buys a ticket (₹1,000)                  │
       │                                                    │
       │  8. Earnings split automatically:                  │
       │     A (Host, 75%):  ₹750 gross → ₹600 net         │
       │     B (Co-Host, 25%): ₹250 gross → ₹200 net       │
       │     Platform: ₹200 (20% total)                     │
```

The system touches five areas: the Prisma schema (collaborator junction tables + modified earnings), a service layer for business logic, API routes for CRUD operations, Stream.io for auto-created chat channels, and dashboard UI for managing invitations.

---

## 2. Inviting a Collaborator

A host can invite collaborators from the "Collaborators" tab in their plan editor (the `CollaboratorsTab` component). The invitation specifies three things: **who** (consultant profile ID), **what role** (CO_HOST, MODERATOR, etc.), and **what share** (a percentage of the plan's revenue).

### The invitation request

When the host clicks "Send Invitation," the frontend sends:

```
POST /api/collaborations/webinar/{planId}
{
  "consultantProfileId": "clx_consultant_b",
  "role": "CO_HOST",
  "revenueSharePercentage": 25
}
```

### What the service validates

The `inviteCollaborator()` function in `lib/collaborators/service.ts` performs several checks before creating the record. These validations are critical because they enforce the system's invariants:

1. **Ownership check**: The API route verifies that the authenticated user is the plan owner by comparing the session user's consultant profile ID against `plan.consultantProfileId`. Only the owner can invite.

2. **Self-invitation prevention**: The consultant profile ID in the request body must differ from the owner's. You can't collaborate with yourself.

3. **Duplicate prevention**: The database has a `@@unique([consultantProfileId, webinarPlanId])` constraint. If Consultant B has already been invited (in any status), the insert fails.

4. **Revenue share validation**: This is the most important check. The service calls `validateRevenueShares()`, which sums up the `revenueSharePercentage` of all existing collaborators in `PENDING` or `ACCEPTED` status, adds the new share, and verifies the total doesn't exceed 90%. This ensures the host always keeps at least 10%.

```
validateRevenueShares("webinar", planId, newShare=25)
        │
        ▼
  Query existing collaborators:
    WHERE webinarPlanId = planId
    AND status IN (PENDING, ACCEPTED)
        │
        ▼
  Sum existing shares:
    Co-Host A: 25% (ACCEPTED)
    Moderator B: 15% (PENDING)
    Total existing: 40%
        │
        ▼
  Check: 40% + 25% = 65% ≤ 90%?
    YES → valid, proceed
    NO  → return null, API returns 400
```

Note that **PENDING invitations count toward the total**. This prevents over-allocation. If the host invites three people at 35% each before any of them respond, the third invitation would be rejected (35 + 35 + 35 = 105% > 90%).

### The created record

If all validations pass, a `WebinarCollaborator` (or `ClassCollaborator`) record is created with `status: PENDING`. The record captures the deal terms — role, revenue share, and who invited whom — so the collaborator can review before accepting.

```
WebinarCollaborator {
  id: "clx_collab_123"
  consultantProfileId: "clx_consultant_b"
  webinarPlanId: "clx_plan_456"
  role: CO_HOST
  revenueSharePercentage: 25.0
  status: PENDING
  invitedById: "clx_consultant_a"
  respondedAt: null
}
```

---

## 3. Responding to an Invitation

When Consultant B logs into their dashboard, they see the invitation on the "Collaborations" page (powered by the `InvitationsPanel` component). The page fetches from `GET /api/collaborations`, which queries both `webinarCollaborator` and `classCollaborator` tables for the authenticated consultant's profile.

### The invitation card

Each pending invitation shows:

- Plan title and type (Webinar/Class)
- Who invited them
- The proposed role (e.g., "CO HOST")
- The revenue share percentage
- The plan's price (so they can estimate their earnings)
- Accept and Decline buttons

### Accepting

When Consultant B clicks "Accept," the frontend sends:

```
PATCH /api/collaborations/{id}/respond
{
  "response": "ACCEPTED",
  "planType": "webinar"
}
```

The `respondToInvitation()` function in the service performs these checks:

1. **Identity verification**: The service looks up the collaboration record and verifies that `consultantProfileId` matches the authenticated user's consultant profile. You can only respond to your own invitations.

2. **Status check**: The collaboration must be in `PENDING` status. You can't re-accept an already accepted invitation or revive a declined one.

If valid, the service updates the record:

```
UPDATE WebinarCollaborator
SET status = 'ACCEPTED',
    respondedAt = NOW()
WHERE id = 'clx_collab_123'
```

### The Stream channel side-effect

After a successful acceptance, something important happens: a Stream.io chat channel is automatically created for the collaboration team. This is covered in detail in the next section, but it's worth noting here because it's part of the acceptance transaction. If the channel creation fails (e.g., Stream API is down), the acceptance still succeeds — the channel creation is wrapped in a try/catch and logged as a non-blocking error.

```
Consultant B            PATCH /api/.../respond          Service                   Stream.io
     │                          │                          │                         │
     │  Click "Accept"          │                          │                         │
     │─────────────────────────>│                          │                         │
     │                          │  respondToInvitation()   │                         │
     │                          │─────────────────────────>│                         │
     │                          │                          │                         │
     │                          │                          │  1. Verify identity     │
     │                          │                          │  2. Check PENDING       │
     │                          │                          │  3. UPDATE → ACCEPTED   │
     │                          │                          │                         │
     │                          │                          │  4. Dynamic import:     │
     │                          │                          │     createCollaborator  │
     │                          │                          │     Channel()           │
     │                          │                          │────────────────────────>│
     │                          │                          │                         │
     │                          │                          │  Channel created:       │
     │                          │                          │  collab-webinar-{planId}│
     │                          │                          │  Members: [A, B]        │
     │                          │                          │<────────────────────────│
     │                          │                          │                         │
     │                          │  200 OK                  │                         │
     │                          │<─────────────────────────│                         │
     │  Toast: "Accepted"       │                          │                         │
     │<─────────────────────────│                          │                         │
```

### Declining

Declining is simpler. The status is updated to `DECLINED`, `respondedAt` is set, and no side effects occur. The revenue share that was reserved for this collaborator is freed up — the host can now invite someone else with that percentage.

---

## 4. Coordinating via Stream Chat

Once a collaborator accepts, the team needs a way to communicate. The system automatically creates a private Stream.io messaging channel for this purpose.

### Channel naming convention

The platform uses a structured channel ID pattern to distinguish different types of conversations:

```
consultation-{consultationId}     messaging    1:1 (consultant + consultee)
subscription-{subscriptionId}     messaging    1:1 (consultant + consultee)
webinar-{webinarId}               team         Group (host + all participants)
class-{classId}                   team         Group (host + all participants)
collab-webinar-{webinarPlanId}    messaging    Private (host + collaborators only)
collab-class-{classPlanId}        messaging    Private (host + collaborators only)
```

Collaborator channels use the `messaging` type (private, invitation-only) rather than `team` (open), because participants in the webinar shouldn't see the behind-the-scenes coordination between host and collaborators.

### How the channel is created

The `createCollaboratorChannel()` function in `actions/stream/chat/channel.action.ts` does the following:

1. Queries the plan to get the host's user ID
2. Queries all accepted collaborators to get their user IDs
3. If there are at least 2 members (host + 1 collaborator), creates the channel
4. Uses Stream's `getOrCreate` behavior, which is idempotent — if the channel already exists (e.g., a second collaborator accepts later), the member list is updated rather than creating a duplicate

The channel carries metadata (`is_collaborator_channel: true`, `{planType}_plan_id: planId`) that the chat UI can use to group and display these channels differently from regular conversations.

### Why dynamic import?

The service layer (`lib/collaborators/service.ts`) uses `await import("@/actions/stream/chat/channel.action")` rather than a static import. This prevents circular dependency issues between the server action module and the service module, and keeps the Stream.io SDK out of the service layer's bundle.

---

## 5. Scheduling with Availability Overlay

Scheduling is host-only — collaborators cannot create events or set timings. But the host needs to know when their collaborators are available. The system provides a co-host availability API that powers a calendar overlay.

### The availability endpoint

```
GET /api/collaborators/{consultantProfileId}/availability?date=2026-03-15
```

This returns three pieces of data for the given date:

1. **Weekly slots**: The collaborator's recurring weekly availability (e.g., "every Saturday 9am-5pm"). Uses the `SlotOfAvailabilityWeekly` model.

2. **Custom slots**: Any one-off availability the collaborator has set for that specific date. Uses the `SlotOfAvailabilityCustom` model.

3. **Booked slots**: Existing appointments that the collaborator has on that date. Determined by querying `SlotOfAppointment` through the nested consultation/subscription/webinar/class relations.

### How the host interprets this

The scheduling calendar shows a color-coded overlay:

- **Green**: The co-host has availability defined AND no existing booking → they're free
- **Yellow**: The co-host has no availability defined for that time → they may be flexible (their schedule just hasn't been set)
- **Red**: The co-host has an existing booking during that time → they're unavailable

The overlay is purely informational. Since scheduling is host-only, the host makes the final call. If a co-host isn't available, the host can either pick a different time or proceed anyway (the collaborator can always adjust their own schedule).

---

## 6. How Revenue Gets Split on Payment

This is the most consequential part of the system. When a customer buys a ticket for a webinar (or enrolls in a class) that has collaborators, the payment amount must be correctly divided among all parties.

### The trigger point

The split happens inside the payment webhook handler (`lib/payments/webhooks/handlers.ts`). After a successful payment, the handler checks whether the associated service has accepted collaborators. If it does, it calls `createCollaboratorEarnings()` instead of the standard `createEarningsFromPayment()`.

```
Payment webhook fires (payment succeeded)
        │
        ▼
  Is this a webinar or class payment?
        │
        ├── NO → createEarningsFromPayment() (standard 1:1 flow)
        │
        ▼ YES
  Does the plan have accepted collaborators?
        │
        ├── NO → createEarningsFromPayment() (solo host)
        │
        ▼ YES
  createCollaboratorEarnings(payment, collaborators)
```

### The split calculation

The `calculateRevenueSplit()` function in `lib/collaborators/service.ts` computes the split. Each collaborator gets their percentage, and the **host gets the remainder** (not a fixed percentage). This is important because rounding can cause fractions of a paise — the host absorbs the rounding error.

Let's walk through a concrete example. A webinar costs ₹1,000. Two collaborators are accepted:

```
Collaborators:
  Co-Host A:   25% → Math.round(1000 * 25/100) = ₹250
  Moderator B: 15% → Math.round(1000 * 15/100) = ₹150

Host gets remainder:
  ₹1,000 - ₹250 - ₹150 = ₹600 (60%)
```

### Creating the earnings records

For each party, the system creates a `ConsultantEarnings` record. The platform fee (20%) is applied independently to each share:

```
┌──────────────────────────────────────────────────────────────┐
│ Party        │ Share %  │ Gross    │ Fee (20%)│ Net Payout  │
├──────────────┼──────────┼──────────┼──────────┼─────────────┤
│ Host         │ 60%      │ ₹600     │ ₹120     │ ₹480        │
│ Co-Host A    │ 25%      │ ₹250     │ ₹50      │ ₹200        │
│ Moderator B  │ 15%      │ ₹150     │ ₹30      │ ₹120        │
├──────────────┼──────────┼──────────┼──────────┼─────────────┤
│ TOTAL        │ 100%     │ ₹1,000   │ ₹200     │ ₹800        │
└──────────────┴──────────┴──────────┴──────────┴─────────────┘
```

Three `ConsultantEarnings` records are created, all linked to the same `paymentId`:

```
Earnings #1: { consultantProfileId: Host,  paymentId: pay_xxx, role: OWNER,        sharePercentage: 60,  grossAmount: 600, platformFee: 120, consultantShare: 480 }
Earnings #2: { consultantProfileId: A,     paymentId: pay_xxx, role: COLLABORATOR, sharePercentage: 25,  grossAmount: 250, platformFee: 50,  consultantShare: 200 }
Earnings #3: { consultantProfileId: B,     paymentId: pay_xxx, role: COLLABORATOR, sharePercentage: 15,  grossAmount: 150, platformFee: 30,  consultantShare: 120 }
```

### The 1:1 → 1:many migration

This was the riskiest schema change in the entire feature. Previously, `ConsultantEarnings.paymentId` had a `@unique` constraint — one earning per payment. To support collaborator splits, this constraint was removed and replaced with a regular `@@index([paymentId])`.

The `Payment` model's relation changed from `earnings ConsultantEarnings?` (optional singular) to `earnings ConsultantEarnings[]` (array). Every location in the codebase that accessed `payment.earnings` as a singular value needed to be updated to handle an array. TypeScript caught all of these at compile time (`tsc --noEmit`), which is why we ran it after every schema change.

### Independent payouts

Each `ConsultantEarnings` record is processed independently by the existing payout system. When a payout batch runs, it groups earnings by `consultantProfileId`. So the host gets their payout, Co-Host A gets theirs, and Moderator B gets theirs — all separately. There's no dependency between them.

---

## 7. Refund Cascade — Unwinding Multi-Party Earnings

When a payment is refunded, all earnings associated with that payment must be refunded. Before collaborators, this was simple: find the one earnings record, mark it refunded, decrement the consultant's `pendingRevenue`. With collaborators, there may be two, three, or more records.

### How refunds work now

```
refundEarnings(paymentId)
        │
        ▼
  findMany({ where: { paymentId } })
  // Was findUnique — now returns array
        │
        ▼
  For EACH earning in the array:
    1. SET status → REFUNDED
    2. DECREMENT consultant's pendingRevenue
       by the earning's consultantShare
```

This same pattern applies to dispute handling (`scripts/disputes/handle-lost-disputes.ts`) and the earnings sync job (`scripts/earnings/sync-payment-earnings.ts`). All three scripts were updated from singular to array iteration.

The key insight is that refunds are all-or-nothing for a payment. You can't refund just the host's share — if the customer gets their money back, everyone's earnings for that payment are reversed.

---

## 8. Removing a Collaborator

The host can remove a collaborator at any time by clicking the trash icon in the `CollaboratorsTab` component. This sends:

```
DELETE /api/collaborations/webinar/{planId}/{id}
```

The service sets `status: REMOVED` (a soft delete — the record persists for audit purposes). The collaborator's revenue share is freed up, and the host can invite someone new.

Important: removing a collaborator only affects **future** payments. If 10 people already bought tickets when the collaborator was active, those 10 earnings records remain. The collaborator keeps what they earned.

---

## 9. The Complete Lifecycle

Here's every state a collaboration can pass through, from creation to final payout:

```
Host creates plan
       │
       ▼
Host invites Consultant B
  (role: CO_HOST, share: 25%)
       │
       ▼
┌──────────────┐
│   PENDING    │  Invitation sent, awaiting response.
│              │  Share is reserved (counts toward 90% cap).
└──────┬───────┘
       │
  ┌────┴────────────┐
  │                 │
  ▼                 ▼
┌──────────┐  ┌──────────┐
│ ACCEPTED │  │ DECLINED │  Collaborator responded.
│          │  │          │  DECLINED frees the share.
│ + Stream │  └──────────┘
│   channel│
│   created│
└──────┬───┘
       │
  ┌────┴──────────────────────────────────────┐
  │                                           │
  │  Active collaboration                     │  Host removes
  │                                           │
  │  - Visible on public plan page            ▼
  │  - Gets earnings share on payments   ┌──────────┐
  │  - Has Stream chat access            │ REMOVED  │  Soft delete.
  │  - Shows in earnings dashboard       │          │  Share freed.
  │                                      │ Existing │  Past earnings
  └──────────────────┐                   │ earnings │  preserved.
                     │                   │ kept     │
                     │                   └──────────┘
                     ▼
           Customer purchases service
                     │
                     ▼
           ┌────────────────────────────┐
           │ Earnings split:            │
           │                            │
           │ Host: remainder (e.g. 75%) │
           │ Collab B: 25%              │
           │                            │
           │ Platform: 20% of each      │
           │ share independently        │
           └────────────┬───────────────┘
                        │
                        ▼
           ┌────────────────────────────┐
           │ Each consultant's earnings │
           │ processed independently:   │
           │                            │
           │ Hold period (7 days)       │
           │     ↓                      │
           │ Payout batch groups by     │
           │ consultant profile         │
           │     ↓                      │
           │ Separate payouts to        │
           │ separate bank accounts     │
           └────────────────────────────┘
```

### What's NOT in the collaborator system (deliberate exclusions)

- **Podcast collaborators**: The `PodcastPlan` model doesn't exist yet. When it does, the same `ClassCollaborator` pattern can be replicated.
- **Stream video call roles**: Calls are created client-side. Assigning collaborator-specific roles (host, moderator, speaker) would require server-side call creation — deferred for now.
- **Collaborator-initiated scheduling**: Only the host can create events and set times. Collaborators see an availability overlay but can't create slots.
- **Channel member removal on REMOVED status**: When a collaborator is removed, they're not automatically kicked from the Stream chat channel. This is a future improvement.
- **Notifications**: The Novu workflow stubs exist but the notification triggers aren't wired up yet.
