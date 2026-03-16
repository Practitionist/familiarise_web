# Architecture Review: Familiarise Web Platform

> Migrated from GitHub Issue #446 (2026-02-19). Comprehensive architecture review covering schema, booking algorithm, payment system, rescheduling, Stream.io, cron jobs, and cross-cutting concerns. Rated 7.5/10.
>
> **Note**: Some findings have been addressed since this review was written. Cross-reference with merged PRs #441, #458, #462, #467 for fixes.

---

**Overall Verdict: 7.5/10 — Impressively ambitious, mostly well-executed, with a few nightmare-grade issues**

For a pre-launch platform built by a 2-3 person team, this is genuinely impressive in scope and thoughtfulness. But there are specific areas that will cause real pain at scale. I'll be direct about each.

---

## 1. Prisma Schema (2250 lines, 60+ models)

### What I Like

- **Polymorphic Appointment model is clever.** The `Appointment` model with nullable FK columns (`consultationId`, `subscriptionId`, `webinarId`, `classId`) and an `AppointmentsType` enum is a pragmatic choice. It avoids the complexity of table-per-type inheritance while keeping queries simple. The `SlotOfAppointment` many-to-many with `User` is the right call for group events.

- **Cancellation tracking is thorough.** Both `Consultation` and `Subscription` have `cancellationReason`, `cancellationNotes`, `cancelledAt`, `cancelledBy`. This is production-grade audit trail thinking.

- **Index strategy is generally solid.** Composite indexes like `@@index([requestedById, requestStatus])`, `@@index([status, holdUntil])`, and `@@index([isTentative, startsAt, endsAt])` show someone who understands query patterns.

- **The payout system is surprisingly mature** — `ConsultantEarnings`, `Payout`, `PayoutAccount`, `Invoice` with proper status enums, idempotency keys, and batch processing. This is ahead of most startups at this stage.

### What I Don't Like

1. **The `User` model is a god object (84 lines, 30+ fields, 20+ relations).**

   ```
   User → consultantProfile, consulteeProfile, staffProfile, adminProfile,
          slotsOfAppointment, payments, feedbacks, supportTickets, accounts,
          sessions, members, referralCode, referral, referralCredits,
          reportsSubmitted, reportsReceived, moderationActions,
          workExperiences, certifications, education, cookiePreferences,
          notificationPreferences, waitlist
   ```

   Every query that touches `User` risks pulling in this entire relation graph. At 10K+ users with eager loading mistakes, this becomes a performance cliff. The `consultantProfileId` and `consulteeProfileId` stored directly on `User` (with `@unique`) means a user can only ever be ONE consultant and ONE consultee. That's fine semantically but creates tight coupling.

2. **The `SlotOfAvailabilityWeekly` time representation is a nightmare waiting to happen.**

   ```prisma
   model SlotOfAvailabilityWeekly {
     dayOfWeekForStartsAt DayOfWeek
     availabilityStartsAt DateTime  @db.Timestamptz()
     dayOfWeekForEndsAt   DayOfWeek
     availabilityEndsAt   DateTime  @db.Timestamptz()
   }
   ```

   You're storing weekly availability using actual `DateTime` values anchored to `1970-01-05` (Monday of epoch week). This means:
   - The "date" part is meaningless but stored in the DB
   - Timezone math requires extracting just the time portion and mapping to the day-of-week enum
   - Anyone querying this table without understanding the 1970 convention will write bugs
   - DST transitions are invisible — a consultant in IST who sets "Monday 9:30 AM" will have their UTC offset change twice a year, but the stored `1970-01-05 04:00:00+00` won't

   This should be time columns (just HH:MM) + day-of-week, or at minimum a `@db.Time` type. The current approach is the #1 source of bugs in your validation code (the `validateMatchesSchedule` function has 170+ lines of workaround logic for this).

3. **No composite unique constraint on `SlotOfAppointment` to prevent duplicates.**

   There's no `@@unique([appointmentId, startsAt])` on `SlotOfAppointment`. This means the same appointment can have two identical 30-minute slots at the same time, and only application-level checks prevent it. At scale with concurrent requests, this is a data integrity gap.

4. **The `Appointment` model has no status field.**

   ```prisma
   model Appointment {
     id                 String              @id @default(uuid())
     appointmentType    AppointmentsType
     slotsOfAppointment SlotOfAppointment[]
     // ... FK relations ...
     // NO status field!
   }
   ```

   The appointment's "status" is derived from its parent entity (`Consultation.requestStatus`, `Subscription.requestStatus`, `Webinar.status`, `Class.status`). This means:
   - You can't query "all cancelled appointments" without joining 4 tables
   - The cleanup jobs have to check each parent type separately
   - The auto-complete-appointments job has 5 separate query blocks for 5 entity types

   A denormalized status field on `Appointment` would eliminate ~200 lines of join logic across your codebase.

5. **`PlanMaterial` uses nullable FKs instead of polymorphic pattern.**

   ```prisma
   model PlanMaterial {
     consultationPlanId String?
     subscriptionPlanId String?
     webinarPlanId      String?
     classPlanId        String?
   }
   ```

   No check constraint ensures exactly one is set. You could have a material linked to both a consultation plan AND a webinar plan, or to nothing at all. Prisma doesn't support check constraints natively, so you'd need a migration-level `CHECK` or application-level validation.

6. **`Payment.paymentIntent` is `@unique` but also the only way to look up payments from webhooks.** If a webhook arrives twice with different event IDs but the same payment intent (which Stripe does for retries), the second webhook correctly dedupes. But if the payment intent is reused across gateways (unlikely but not impossible with mock payments using `mock_` prefix), you'd get a unique constraint violation. The `@@unique([userId, appointmentId])` comment says "Allow multiple users to pay for same appointment (webinars/classes)" but that's not what `@@unique` does — it PREVENTS multiple users from paying for the same appointment. This is a logic error in the comment or the constraint.

### What Could Cause Production Nightmares

- **The `onDelete: Cascade` on `Consultation → ConsultationPlan`** means deleting a plan deletes ALL consultations. If an admin accidentally deletes a consultation plan, every consultation, appointment, slot, payment reference, and chat channel linked to it vanishes. There's no soft-delete mechanism. Same applies to `Subscription → SubscriptionPlan`, `Webinar → WebinarPlan`, `Class → ClassPlan`.

- **No row-level security (RLS) at the database level.** All access control is application-level. A single misconfigured API route (or a Prisma Studio session) can expose or modify any user's data. With Supabase, you have RLS available — not using it is a conscious risk.

---

## 2. Booking Algorithm

### What I Like

The 5-layer validation architecture is excellent:

1. Zod schema validation (type safety)
2. `SlotValidationService` (business rules — 7 independent checks)
3. `SlotAllocationService` (allocation logic)
4. Distributed locking (Redis via Upstash)
5. Database transactions (120s timeout)

- **The centralized `occupancyPolicy.ts` is smart.** A single file defines what "occupied" means across all service types. Before this existed (Bug #15), different parts of the code had different definitions, causing phantom conflicts.

- **The tentative slot mechanism is well-designed.** `isTentative: true` during checkout/reschedule, confirmed after payment, cleaned up by cron jobs. This prevents the classic double-booking-during-payment race condition.

- **The `SlotCalculationService` as single source of truth** for all calculations prevents the classic bug where frontend and backend calculate slot counts differently.

### What I Don't Like

1. **`SlotAllocationService.autoAllocate()` has NO distributed lock.**

   This is the single most dangerous bug in the entire codebase.

   The request-for-approval route uses `lockSlotBooking()`. The checkout route uses `lockSlotBooking()`. But `autoAllocate()` — the function that FINDS and ASSIGNS slots automatically — uses only a Prisma transaction, NOT a Redis lock.

   Race condition scenario with 2 concurrent requests:
   ```
   Consultant A: auto-allocate subscription (finds Mon 10:00 available)
   Consultant B: auto-allocate subscription (finds Mon 10:00 available) ← same slot!
   Both transactions commit → DOUBLE BOOKING
   ```

   Prisma transactions use READ COMMITTED isolation by default, NOT SERIALIZABLE. Two concurrent transactions can both read the same slot as "available" and both write to it. The `reconcile-slot-availability` cron job will DETECT this, but by then both consultees have confirmed appointments.

2. **The weekly schedule matching has a hardcoded timezone cutoff.**

   ```typescript
   // SlotValidationService.ts line 369
   const nextDayFromSlot = (slotDay + 1) % 7;
   if (nextDayFromSlot === availDay && slotHours >= 18) {
   ```

   This assumes any slot at 18:00+ UTC might be "next day" in the consultant's timezone. This works for IST (UTC+5:30) but breaks for:
   - Pacific time (UTC-8): 18:00 UTC = 10:00 AM (same day, not next)
   - Japan (UTC+9): 03:00 UTC = 12:00 PM (should check previous day, not next)

3. **Subscription auto-allocation uses Sunday-based weeks**, which misaligns with most global calendars. ISO 8601 defines Monday as the first day of the week. Indian and European calendars typically start on Monday. This means "2 calls per week" could span Friday-Saturday-Sunday differently than the user expects.

### What Could Cause Production Nightmares

- **The 120-second transaction timeout** for slot allocation is necessary because the algorithm does multiple DB queries inside the transaction. But on a loaded PostgreSQL instance with many concurrent allocations, this creates lock contention. 10 concurrent subscription allocations (each taking 5-10 seconds) would queue up, and later ones would timeout. At scale, you need to move to an optimistic concurrency model (version fields + retry) instead of long-lived transactions.

- **No circuit breaker on Redis lock acquisition.** If Upstash Redis goes down, every slot booking attempt hangs for the full retry duration (10 attempts × exponential backoff ≈ 30+ seconds), then fails. There's no fallback to database-level locking. At 1000 concurrent users, a Redis outage becomes a full platform outage.

---

## 3. Payment System

### What I Like

The 5-step checkout flow is well-engineered:

1. Calculate & validate (outside lock)
2. Acquire distributed lock
3. Re-validate inside lock (TOCTOU prevention)
4. Create payment intent
5. Create tentative appointment + payment record

- **The TOCTOU (Time-of-Check-Time-of-Use) prevention** — re-validating inside the lock — is exactly right. Many startups skip this and get double-charged.

- **The two-phase webhook handler** (Phase 1: critical payment+appointment, Phase 2: non-critical earnings/notifications) with fallback cron jobs is resilient design. If Phase 2 fails, the `sync-payment-earnings` job picks it up.

- **The `PaymentIntentManager` class** tracks created payment intents for cleanup if the DB transaction fails after creating the intent. This prevents orphaned charges.

- **Mock payment support is smart for development** — it follows the same code path but skips the gateway call and immediately confirms. This means your test coverage is meaningful.

### What I Don't Like

1. **The `@@unique([userId, appointmentId])` on `Payment` is wrong for webinars/classes.** The comment says "Allow multiple users to pay for same appointment" but `@@unique` PREVENTS that. For a webinar with 40 participants, each paying separately, they'd need separate appointment IDs. This works because webinars create one appointment per webinar (not per user), but if you ever refactor to per-user appointments, this constraint silently breaks.

2. **GST calculation is hardcoded at 18%.**

   ```typescript
   const taxAmount = Math.round(discountedAmount * 0.18);
   ```

   No configuration, no per-plan tax rate, no international tax handling. When you expand beyond India, or when GST rates change (they do — India has 5%, 12%, 18%, 28% slabs), this becomes a compliance nightmare. Tax should be a first-class configurable entity.

3. **Refund logic is completely decoupled from cancellation.** The cancel endpoint deletes the appointment but does NOT trigger a refund. Refunds happen via a separate admin API or cleanup jobs. This means:
   - User cancels → sees "Cancelled" immediately
   - User waits days/weeks for refund
   - No automatic refund policy (e.g., "full refund if >24h before session")
   - Support tickets pile up asking "where's my refund?"

4. **No idempotency key on the checkout endpoint itself.** If a user double-clicks "Pay" and two requests arrive simultaneously, both will try to acquire the lock. The lock prevents double-booking, but both requests create payment intents with the gateway, and only one succeeds — the other becomes an orphaned charge that needs manual cleanup.

### What Could Cause Production Nightmares

- **The payment-appointment link relies on webhook delivery.** If Stripe/Razorpay webhook fails (network issue, server restart, queue overflow):
  1. User pays successfully
  2. Appointment stays tentative
  3. `reconcile-payment-status` job (30-min interval) eventually catches it
  4. For 30 minutes, the user sees "Pending" after paying

  At scale, this 30-minute window creates massive support volume. You need a client-side polling mechanism that checks payment status every 5 seconds after redirect.

- **The `handlePaymentSuccess` webhook has a critical edge case:** If metadata validation fails (missing required fields), the payment is marked SUCCEEDED but the appointment is NOT created. The code logs a "P1 CRITICAL" alert and sets a `REQUIRES_MANUAL_RECOVERY` description. But there's no automated recovery — someone has to manually create the appointment. At 2 AM on a Saturday, this means a paying customer has no appointment until Monday.

---

## 4. Rescheduling & Cancellation

### What I Like

- **Type confusion attack prevention.** The reschedule endpoint derives the appointment type from the DB, not the query parameter. This prevents a malicious user from passing `?type=WEBINAR` for a consultation appointment to bypass consultant-only restrictions.

- **Partial subscription reschedule is sophisticated** — you can reschedule individual sessions within a subscription without affecting others. The `slotIds` array approach is flexible.

- **The 24-hour minimum restriction is enforced server-side** for all slots in the request. No client-side bypass possible.

### What I Don't Like

1. **Cancel does NOT check if the appointment is already completed.**

   There's no validation like:
   ```typescript
   if (appointment.status === 'COMPLETED') {
     return error("Cannot cancel completed appointment");
   }
   ```

   A user could cancel a consultation that already happened 3 days ago, deleting the appointment record and losing the audit trail. The cleanup job would need to handle refund eligibility for completed sessions differently.

2. **No notifications sent on reschedule.** The consultee gets no email/push when the consultant reschedules their appointment. They'd only see the change if they check their dashboard. For a session that was tomorrow and is now next week, this is terrible UX.

3. **Reschedule doesn't validate remaining subscription sessions meet plan requirements.** If a subscription has 6 sessions (2/week for 3 weeks) and you reschedule 4 of them, there's no check that the remaining 2 still satisfy the weekly cadence. You could end up with all 6 sessions in week 1 and nothing in weeks 2-3.

### What Could Cause Production Nightmares

- **Concurrent reschedules on the same subscription have no locking.** Two requests to reschedule different sessions of the same subscription can run simultaneously. Both read the current state, both mark different slots as tentative, and the resulting state is unpredictable. The Prisma transaction prevents partial updates but NOT concurrent modifications to the same subscription.

---

## 5. Stream.io Video & Chat

### What I Like

- **The caching strategy is thoughtful** — 5-minute TTL for user sync, 2-minute for channel existence, 1-minute for membership. This dramatically reduces Stream API calls.

- **Batch user upsert (`upsertUsersToStream`)** instead of individual calls is the right approach. One API call for N users instead of N calls.

- **The recording lifecycle is complete** — start → webhook (ready/failed) → sync service for missed webhooks → expiration tracking → transfer to Supabase.

### What I Don't Like

1. **Stream webhook signature is NOT verified.**

   ```typescript
   // TODO: Should verify webhook signature from Stream
   ```

   This means ANYONE can POST to your webhook endpoint and create fake recordings, fake call events, or manipulate meeting state. In production, this is an immediate security vulnerability. An attacker could:
   - Create fake "recording ready" events with malicious URLs
   - Mark meetings as "ended" to disrupt active sessions
   - Inject fake call metadata

2. **Recording URLs expire in 14 days with no automated transfer.** The `getExpiringRecordings()` method exists, but the actual transfer-to-Supabase job is marked as "TODO." After 14 days, recordings become inaccessible. For paid webinar recordings that consultees expect permanent access to, this is a broken promise.

3. **No virus/malware scanning on document uploads.** The document review system accepts PDF, Word, and image files up to 10MB. Without scanning, a malicious consultee could upload a weaponized PDF that exploits the consultant's PDF reader. The MIME type whitelist helps but isn't sufficient (MIME types can be spoofed).

4. **The in-memory caching is per-process, not shared.** In a Vercel serverless environment, each function invocation gets its own memory. The `userSyncCache`, `channelExistsCache`, and `membershipCache` are effectively useless in production because every cold start wipes them. You need Redis-backed caching (which you already have for locks) or accept the redundant Stream API calls.

### What Could Cause Production Nightmares

- **Channel creation for a webinar with 100+ participants** pulls ALL user records from the database, maps them, and calls Stream in a single API call. If any user has invalid data (null name, etc.), the entire channel creation fails and no one gets chat access. There's no partial retry or graceful degradation.

---

## 6. Cron/Cleanup Jobs

### What I Like

- **26 cleanup routes covering every lifecycle edge case** — this is extraordinary thoroughness. Most startups have 3-5 cron jobs. You have dedicated jobs for:
  - Tentative slot cleanup (2h)
  - Stale pending consultations (hourly)
  - Payment reconciliation (30min)
  - Refund cascading (15min)
  - Payout batch creation (weekly)
  - Dispute deadline alerts (hourly)
  - Document storage reconciliation (daily)

- **All jobs are idempotent** (safe to run multiple times). This is exactly right for cron jobs that might overlap or retry.

- **The 207 status code pattern** for "success but with alerts" is clever — it lets monitoring systems differentiate between "clean run" (200) and "ran successfully but found problems" (207).

### What I Don't Like

1. **No job scheduling framework.** All 26 jobs are triggered via API endpoints with `CRON_SECRET` auth. There's no centralized scheduler showing what runs when, no dependency management, no execution history dashboard. If the tentative-slots job fails silently for a week, no one knows until slots pile up.

2. **The `cleanup-invalid-appointments` job uses heuristic duplicate detection.**

   ```
   // Same user + plan + identical slot times + created within 30 seconds
   ```

   "Within 30 seconds" is arbitrary. A slow network could cause legitimate duplicates 60 seconds apart, which this misses. A fast bot could create malicious duplicates 1 second apart, which this catches but then deletes potentially legitimate bookings.

3. **No cleanup for activity logs.** `ActivityLog` has no TTL, no archival. At 1000 consultants generating 10 events/day, that's 3.6M rows/year with no pruning. The `@@index([consultantProfileId, createdAt(sort: Desc)])` index helps query performance but the table size will still impact backup times and migrations.

4. **Double-booking detection doesn't auto-fix.** The `reconcile-slot-availability` job detects double bookings and returns HTTP 207, but leaves them in place for manual resolution. At 3 AM with 10 double bookings, someone needs to wake up and decide which booking to cancel. There should be an automated policy (e.g., cancel the later-created booking and issue a refund).

---

## 7. Cross-Cutting Concerns

#### Missing: Rate Limiting

No rate limiting on any API endpoint. A malicious user could:
- Spam the checkout endpoint to create hundreds of payment intents
- Flood the validate endpoint to map out a consultant's entire availability
- DDoS the slot booking endpoint to lock out all slots via Redis locks

#### Missing: Audit Log

Beyond `ActivityLog` (consultant-facing), there's no system-wide audit trail. When an admin changes a payment status, deletes a consultation, or modifies a user role, there's no immutable record. For a financial platform, this is a compliance gap.

#### Missing: Data Retention Policy

No mechanism to delete user data on request (GDPR Article 17). The cascade deletes would work for account deletion, but there's no endpoint to export user data (GDPR Article 20) or to anonymize instead of delete.

#### Missing: Database Connection Pooling Strategy

With 214 API routes on Vercel's serverless model, each function invocation creates its own Prisma client. Without proper connection pooling (PgBouncer or Supabase's built-in pooler), you'll hit PostgreSQL's `max_connections` limit at ~50 concurrent users. The Prisma 7 config likely handles this, but it's not documented or verified.

---

## Severity Ranking: Top 10 Issues

| # | Issue | Severity | Effort to Fix |
|---|-------|----------|---------------|
| 1 | No distributed lock on `autoAllocate()` — double-booking possible | 🔴 CRITICAL | 2 hours |
| 2 | Stream webhook signature not verified — anyone can forge events | 🔴 CRITICAL | 1 hour |
| 3 | No recording transfer job — recordings disappear after 14 days | 🟠 HIGH | 1 day |
| 4 | Cancel doesn't check completion status — can delete completed appointments | 🟠 HIGH | 30 min |
| 5 | No refund-on-cancel automation — manual refund creates support burden | 🟠 HIGH | 2 days |
| 6 | Weekly availability uses `DateTime` instead of `Time` — source of timezone bugs | 🟠 HIGH | 3 days (migration) |
| 7 | `Payment.@@unique([userId, appointmentId])` — blocks multi-user payments | 🟡 MEDIUM | 1 hour |
| 8 | Cascade delete on plans — admin can accidentally nuke all bookings | 🟡 MEDIUM | 2 hours |
| 9 | No `Appointment.status` field — forces 4-table joins everywhere | 🟡 MEDIUM | 1 day (migration) |
| 10 | In-memory caching useless on Vercel — Stream API calls not cached | 🟡 MEDIUM | 4 hours |

---

## Final Thoughts

**What's genuinely impressive:** The depth of the cleanup/cron system, the distributed locking architecture, the occupancy policy centralization, the tentative slot mechanism, and the two-phase webhook handler. These show production thinking that most pre-launch startups don't have.

**What needs immediate attention before launch:** The auto-allocate locking gap (#1), the Stream webhook verification (#2), and the recording transfer job (#3). These three will cause real damage in production.

**The biggest architectural bet:** Using 30-minute fixed slots as the atomic unit. This simplifies everything but means you can never offer 15-minute or 45-minute sessions without a schema migration. If competitors start offering flexible session lengths, this becomes a product constraint.
