# Schema Architecture Review

> Migrated from GitHub Issue #299 (2026-01-02). Detailed review of the Prisma schema covering structural risks, normalization suggestions, and design patterns. Some suggestions have been addressed in subsequent migrations; others remain relevant as reference material.

---

First of all: **this is an extremely mature schema**. For a pre-launch product, this is well beyond MVP territory. You’ve clearly been thinking in *platform*, *ops*, *finance*, and *scale* terms, not just “booking calls”. That’s a strength—but it also creates some risks I’ll call out.

I’ll break this into **clear sections** so it’s actionable:

---

## 1. High-level verdict (important)

**You do NOT need:**

* Friend requests
* Social graph / followers
* ML recommendations (yet)

**You probably DO need (before launch):**

* A notification/event queue (yes)
* Stronger audit / event logs
* A lighter “communication” abstraction (messages, system notifications)
* Some simplification / normalization fixes

Your schema is **overbuilt for launch**, but **under-instrumented for learning**.

---

## 2. Bugs, smells & structural risks (schema-level)

### 2.1 `User.role` vs multiple profiles → potential inconsistency

You have:

```prisma
role UserRole? @default(CONSULTEE)

consultantProfile ConsultantProfile?
consulteeProfile ConsulteeProfile?
staffProfile StaffProfile?
adminProfile AdminProfile?
```

**Problem**

* Nothing enforces consistency between `role` and profile presence
* A user could have:

  * role = CONSULTANT
  * but only `consulteeProfile` filled

**Suggestion**
Either:

**Option A (cleaner):**

* Remove `role`
* Derive role from profile existence

**Option B (safer):**

* Enforce via application invariant + DB CHECK (if possible)
* Or split users into `User` + `UserRoleAssignment` table

👉 This *will* bite you later in auth & permissions.

---

### 2.2 `Education` model allows orphaned records

You already note it:

```prisma
// Application logic must ensure exactly one of consultantProfileId or
// consulteeProfileId is set
```

**Risk**

* Prisma + Postgres won’t enforce this
* Orphaned education rows are very likely

**Fix**

* Split into:

  * `ConsultantEducation`
  * `ConsulteeEducation`

Yes, duplication is worth the safety.

---

### 2.3 `SlotOfAvailabilityWeekly` time modeling is odd

```prisma
dayOfWeekForStartsAt DayOfWeek
availabilityStartsAt DateTime
```

**Problem**

* A weekly recurring slot should NOT store absolute DateTime
* DST / timezone shifts will break this

**Better**

```text
dayOfWeek
startTime (HH:mm)
endTime (HH:mm)
timezone
```

Then materialize concrete slots when needed.

---

### 2.4 `SlotOfAppointment.user User[]` is vague

```prisma
user User[] @relation("SlotOfAppointmentToUser")
```

**Problem**

* Who are these users?

  * Consultant?
  * Consultee?
  * Staff observer?
* No role or metadata

**Fix**
Introduce join table:

```prisma
SlotParticipant {
  slotId
  userId
  role (CONSULTANT | CONSULTEE | HOST | OBSERVER)
}
```

This unlocks:

* Multi-consultee group calls
* Staff shadowing
* Recordings permissions

---

### 2.5 Payments uniqueness bug (important)

```prisma
@@unique([userId, appointmentId])
```

Comment says:

```
// Allow multiple users to pay for same appointment (webinars/classes)
```

This **does the opposite**.

**Bug**

* This prevents a user from paying twice
* But allows *multiple users* per appointment (OK)
* However:

  * Webinars often allow **same user** to pay again after failure

**Fix**
Use:

```prisma
@@index([userId, appointmentId])
```

And rely on `paymentIntent` uniqueness instead.

---

### 2.6 NotificationPreference is underpowered

You have:

```prisma
mentions
directMessages
updates
```

But you don’t actually have:

* A message system
* A notification entity
* A delivery channel model

This is a **half abstraction**.

---

## 3. Do you need friend requests?

**Short answer:** ❌ **No**

**Long answer:**
This is a **marketplace**, not a social network.

Your relationships are:

* Transactional
* Contextual (consultation, class, subscription)
* Time-bound

Friend requests introduce:

* Moderation complexity
* Spam risk
* Expectations of chat / feed / presence

**What users actually want instead**

* Save consultants
* Re-book consultants
* Message within context
* Follow updates *passively*

### Replace friend requests with:

```text
SavedConsultant
RecentlyWorkedWith
PastConsultationHistory
```

If later:

* Consultants want to “build audience” → introduce **Followers**, not friends

---

## 4. Missing systems you SHOULD consider

### 4.1 Notification / Event Queue (YES, you need this)

Right now:

* Notifications are implicit
* Side effects likely live in app code

**You should add:**

```text
NotificationEvent
NotificationDelivery
```

**Why**

* Payment success
* Booking approved
* Reminder before session
* Feedback request
* Survey after session

Use:

* DB-backed queue (simple)
* Or external (BullMQ, SQS, etc.)

This also enables:

* Retry
* Audit
* Analytics

---

### 4.2 System audit log (very important for SaaS)

You handle:

* Payments
* Refunds
* Disputes
* Cancellations

You **must** log:

```text
Actor (user/system)
Action
Entity
Before/After
Timestamp
```

Add:

```prisma
AuditLog {
  actorUserId?
  action
  entityType
  entityId
  metadata Json
}
```

This saves you legally and operationally.

---

### 4.3 Messaging (but scoped)

You do NOT need global chat.

You DO need:

* Consultation-scoped messages
* Appointment-scoped messages

```text
Conversation
Message
```

Scoped by:

* Appointment ID
* Visibility rules

---

## 5. Overengineering flags (things to postpone)

### 5.1 Machine Learning recommendations ❌ (for now)

You don’t have:

* Enough users
* Enough interactions
* Enough cold-start resolution

**Start with**

* Rule-based ranking:

  * Rating
  * Availability
  * Price match to budget
  * Language match
  * Domain match

Later:

* Collaborative filtering
* Sequence modeling

ML before launch = wasted effort.

---

### 5.2 Too many enums early

Enums like:

* CareerStage
* BudgetPreference
* SessionType

These are fine, but:

* Expect to change them
* Hard enums slow iteration

Suggestion:

* Keep enums for **system-critical states**
* Use lookup tables for user-facing categories

---

## 6. Biggest strategic feedback (non-technical)

### You’ve built a **perfect backend** for a product you haven’t validated yet.

Before adding *anything* else, ask:

* What is the ONE core flow?

  * 1:1 consultation booking?
  * Subscription mentoring?
* What happens in first 10 minutes of user onboarding?

Your schema supports **everything**.
Your risk is launching **nothing clearly**.

---

## 7. If I had to give you a priority list

### Before launch (top priority)

1. Fix role/profile consistency
2. Add notification + event queue
3. Add audit log
4. Simplify availability slots
5. Scoped messaging

### After launch

1. Save consultants / re-book UX
2. Feedback analytics
3. Smart defaults & ranking
4. Light recommendations (rules)

### Much later

* Followers
* ML
* Social features

---

## Final honest take

> **This is one of the most comprehensive early-stage SaaS schemas I’ve seen.**

Your risk is **not missing features**.
Your risk is **shipping too late**.

If you want, next we can:

* Do a **“cut this down to launch” version**
* Or review **only the critical booking/payment path**
* Or design **notification + queue models cleanly**

Just tell me where you want to zoom in.

