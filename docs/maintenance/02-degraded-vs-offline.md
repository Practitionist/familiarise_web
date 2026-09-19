# DEGRADED vs OFFLINE: Phase Comparison

## Summary

| Aspect              | DEGRADED                                          | OFFLINE                                          |
| ------------------- | ------------------------------------------------- | ------------------------------------------------ |
| **Purpose**         | Non-critical work, config changes, cosmetic fixes | DB migrations, schema changes, major deployments |
| **User experience** | Warning banner, site fully functional             | Full maintenance page, all navigation blocked    |
| **Banner**          | Yellow dismissible banner at top                  | Full-screen maintenance page with auto-refresh   |
| **BetterStack**     | No incident created                               | Auto-creates incident                            |

## Error boundaries during an active phase

OFFLINE is a nav-less full-page screen shown for every non-exempt page: the middleware rewrite in `middleware.ts` replaces the requested page with `app/maintenance/page.tsx`, and that screen carries no site navigation. DEGRADED instead keeps the ordinary site navigation and layers the "Scheduled maintenance" banner (`components/banners/MaintenanceBanner.tsx`) on top of it, because reads are still allowed and a user should be able to keep browsing. Neither of those rules changes.

The gap they left open was in the error boundary rather than in the gate itself. A server-component render can still throw while DEGRADED is active — most often because a stale deploy's reads no longer match the live schema — and `app/error.tsx` used to show its generic "Something went wrong" card underneath the banner and navigation with no indication that maintenance was the cause. `app/error.tsx` now makes one `/api/health` call on mount (the same maintenance-exempt endpoint the `/maintenance` page reads) and, when the reported phase is `DEGRADED` or `OFFLINE`, renders the maintenance message — the site logo, the reason, the formatted ETA, and a "Try Again" action — in place of the generic card. When the phase is `OFF`, or the health call itself fails, the generic card is shown exactly as before.

## Detailed Component Behavior

### User-Facing Pages

| Component                          | DEGRADED                         | OFFLINE                      |
| ---------------------------------- | -------------------------------- | ---------------------------- |
| Public pages (home, explore, etc.) | Accessible with banner           | Redirected to `/maintenance` |
| Dashboard pages                    | Accessible with banner           | Redirected to `/maintenance` |
| Auth pages (login, signup)         | Accessible                       | Redirected to `/maintenance` |
| Checkout flow                      | Accessible (gap -- should block) | Blocked                      |
| Meeting/video pages                | Accessible                       | Blocked                      |
| Profile/settings                   | Accessible                       | Blocked                      |

### API Routes by Category

| Route Category                                                                  | DEGRADED                                 | OFFLINE                    | Risk Level |
| ------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------- | ---------- |
| **Webhooks** (`/api/webhooks/*`)                                                | Exempt -- always processed               | Exempt -- always processed | Low        |
| **Health** (`/api/health`)                                                      | Exempt -- always responds                | Exempt -- always responds  | None       |
| **Auth** (`/api/auth/*`)                                                        | Exempt -- always works                   | Exempt -- always works     | None       |
| **Maintenance API** (`/api/admin/maintenance`)                                  | Exempt                                   | Exempt                     | None       |
| **Checkout** (`POST /api/checkout`, `DELETE /api/checkout/pending/[paymentId]`) | **Writes blocked (503)**                 | Blocked (503)              | HIGH       |
| **Checkout verify** (`GET /api/checkout/verify` without `sync`)                 | Allowed (read-only status poll)          | Blocked (503)              | LOW        |
| **Cancel appointment** (`/api/appointments/[id]/cancel`)                        | **Writes blocked (503)**                 | Blocked                    | MEDIUM     |
| **Reschedule** (`/api/appointments/[id]/reschedule`)                            | **Writes blocked (503)**                 | Blocked                    | MEDIUM     |
| **Documents** (`/api/appointments/[id]/documents`)                              | Allowed                                  | Blocked                    | LOW        |
| **Consultations** (`/api/bookings/consultations`)                               | GET: Allowed, POST/PATCH: **blocked**    | Blocked                    | HIGH       |
| **Subscriptions** (`/api/bookings/subscriptions`)                               | GET: Allowed, POST: **blocked**          | Blocked                    | HIGH       |
| **Webinars** (`/api/bookings/webinars`)                                         | GET: Allowed, POST: **blocked**          | Blocked                    | MEDIUM     |
| **Classes** (`/api/bookings/classes`)                                           | GET: Allowed, POST: **blocked**          | Blocked                    | MEDIUM     |
| **Allocate slots** (`/api/bookings/*/allocate`)                                 | **Writes blocked (503)**                 | Blocked                    | HIGH       |
| **Validate** (`/api/bookings/*/validate`)                                       | Allowed (read-only)                      | Blocked                    | LOW        |
| **Trials** (`/api/trials`, `/api/trials/[id]`)                                  | **Writes blocked (503)**                 | Blocked                    | MEDIUM     |
| **Plans** (`/api/plans/*`)                                                      | GET: Allowed, POST/PATCH: Allowed (gap)  | Blocked                    | MEDIUM     |
| **Slot appointments** (`/api/scheduling/appointments`)                          | **Writes blocked (503)** (Mar 2026)      | Blocked                    | HIGH       |
| **Waitlist / newsletter** (`/api/waitlist`)                                     | **Writes blocked (503)** (Mar 2026)      | Blocked                    | LOW        |
| **Referrals** (`/api/referrals`)                                                | **Writes blocked (503)** (Mar 2026)      | Blocked                    | MEDIUM     |
| **Collaborations** (`/api/collaborations`)                                      | **Writes blocked (503)** (Mar 2026)      | Blocked                    | MEDIUM     |
| **Disputes** (`/api/payments/disputes`)                                         | **Writes blocked (503)** (Mar 2026)      | Blocked                    | HIGH       |
| **Admin payouts** (`/api/admin/payouts`)                                        | **Writes blocked (503)** (Mar 2026)      | Blocked                    | HIGH       |
| **Payment recovery** (`/api/payments/*/recover`)                                | **Writes blocked (503)** (#1741)         | Blocked                    | HIGH       |
| **Recording purchase** (`/api/recordings/*/purchase`)                           | **Writes blocked (503)** (#1741)         | Blocked                    | HIGH       |
| **Overage order** (`/api/overage/*/order`)                                      | **Writes blocked (503)** (#1741)         | Blocked                    | HIGH       |
| **Participants** (`/api/participants`)                                          | **Writes blocked (503)** (#1741)         | Blocked                    | MEDIUM     |
| **Meetings join/end** (`/api/meetings/*/join`, `/api/meetings/*/end`)           | **Writes blocked (503)** (#1741)         | Blocked                    | MEDIUM     |
| **Checkout verify sync** (`GET /api/checkout/verify?sync=true`)                 | **Blocked (503)** (#1741)                | Blocked                    | HIGH       |
| **Admin refunds** (`/api/admin/refunds`)                                        | **Writes blocked (503)** (#1598 P1-W02a) | Blocked                    | HIGH       |
| **TDS filing marks** (`/api/admin/tds`)                                         | **Writes blocked (503)** (#1598 P1-W02a) | Blocked                    | MEDIUM     |
| **Billing-account writes** (`/api/admin/billing-accounts`)                      | **Writes blocked (503)** (#1598 P1-W02a) | Blocked                    | HIGH       |
| **User routes** (`/api/user/*`)                                                 | Allowed                                  | Blocked                    | LOW        |
| **Admin routes** (`/api/admin/*`, other than the three rows above)              | Allowed                                  | Blocked                    | LOW        |
| **Staff routes** (`/api/staff/*`)                                               | Allowed                                  | Blocked                    | LOW        |

### Infrastructure Components

| Component                             | DEGRADED                                           | OFFLINE                               | Notes                                               |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| **Cron jobs (GitHub Actions)**        | Run normally, log a warning (`abortIfMaintenance`) | Exit 0 cleanly (`abortIfMaintenance`) | See Gap 2 below for the 12 jobs that skip the guard |
| **Video calls (Stream.io)**           | Active calls continue                              | Active calls continue (gap)           | Stream infrastructure is external                   |
| **Chat (Stream.io)**                  | Works normally                                     | Works normally (gap)                  | Client-side SDK, not routed through middleware      |
| **Email notifications (Novu/Resend)** | Sent normally                                      | Sent normally                         | External service, not affected                      |
| **File storage (Supabase)**           | Accessible                                         | API blocked, but direct URLs work     | Upload routes blocked, existing files accessible    |
| **Redis**                             | Normal operation                                   | Normal operation                      | Maintenance state stored here                       |
| **PostgreSQL**                        | Normal operation                                   | May be mid-migration                  | This is the critical component during OFFLINE       |

## Current Gaps

### Gap 1: DEGRADED Now Blocks Critical Writes (Partially Resolved Mar 2026)

**Previous problem**: In DEGRADED mode, the middleware only added informational headers (`x-maintenance-phase`, `x-maintenance-reason`, `x-maintenance-eta`). All write operations (POST, PATCH, DELETE) proceeded normally.

**Mar 2026 fix**: The following routes are now **write-blocked** (return 503) during DEGRADED mode:

| Route                                         | Reason                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/api/scheduling/appointments`                | Prevent slot modifications during maintenance                                                                            |
| `/api/waitlist`                               | Prevent newsletter signups                                                                                               |
| `/api/referrals`                              | Prevent referral creation                                                                                                |
| `/api/collaborations`                         | Prevent collaboration changes (the old `/api/collaborators` entry matched no real route; #1741)                          |
| `/api/payments/disputes`                      | Prevent dispute evidence submission                                                                                      |
| `/api/admin/payouts`                          | Prevent payout batch creation/approval                                                                                   |
| `/api/payments/*/recover`                     | Prevent an admin re-drive of a payment (#1741)                                                                           |
| `/api/recordings/*/purchase`                  | Prevent a recording purchase (#1741)                                                                                     |
| `/api/overage/*/order`                        | Prevent an overage order (#1741)                                                                                         |
| `/api/participants`                           | Prevent a seat removal, whose DELETE refunds through `refundRemovedAttendeeSeat` (#1741)                                 |
| `/api/meetings/*/join`, `/api/meetings/*/end` | Agree with the provision-side refusal a call join/end already has (#1741)                                                |
| `GET /api/checkout/verify?sync=true`          | This GET drives a capture and therefore writes money; special-cased ahead of the read-only-methods short-circuit (#1741) |
| `/api/admin/refunds`                          | The admin refund front door is a money write, not a read (#1598 P1-W02a)                                                 |
| `/api/admin/tds`                              | Prevent marking a TDS filing as reported mid-maintenance (#1598 P1-W02a)                                                 |
| `/api/admin/billing-accounts`                 | Prevent a wallet unfreeze mid-maintenance (#1598 P1-W02a)                                                                |

**Status**: checkout (the POST and the `sync=true` verify GET; the plain verify GET stays a read), appointment cancel/reschedule, event CRUD (webinars, classes), and trial routes are all now write-blocked in DEGRADED mode too — see `lib/maintenance-edge.ts`'s `WRITE_BLOCKED_IN_DEGRADED` list for the current, complete set of doors.

### Gap 2: Cron Jobs Bypass Middleware — Resolved via `abortIfMaintenance()`

**Resolved**: All 27 cron jobs now call `abortIfMaintenance()` (`lib/maintenance-cron.ts`) at startup. On OFFLINE mode the job exits 0 cleanly; on DEGRADED mode it logs a warning and continues. The jobs cannot intercept maintenance state through the Next.js middleware (they run directly as `npx tsx` processes in GitHub Actions), but they check the same Redis key directly, achieving the same effect.

**Residual concern**: A job that is already mid-run when OFFLINE mode is activated will finish its current work. The guard is entry-time only — there is no checkpoint inside long jobs. For short jobs (typical <5s) this is harmless; for longer jobs (`sync-payment-earnings`, `reconcile-ledgers`) keep the 2-minute settling window in the pre-maintenance checklist.

**Affected jobs**: 49 of the 61 scheduled jobs. The other 12 never call the guard and run straight through OFFLINE -- see [Cron Jobs Reference](./04-cron-jobs-reference.md)

### Gap 3: Active Video Calls Not Terminated

**Problem**: Stream.io video calls are managed by external infrastructure. Entering OFFLINE mode doesn't disconnect active calls.

**Impact**: Users in active calls can continue, but if the DB is being migrated, any actions that require DB access (saving notes, marking as complete) will fail silently.

### Gap 4: BetterStack Incident Not Created for DEGRADED

**Problem**: BetterStack auto-creates an incident only when entering OFFLINE mode. DEGRADED mode does not trigger an incident.

**Impact**: If users or external stakeholders check the public status page (https://familiarise.betteruptime.com) during DEGRADED mode, it shows "All systems operational" — which is technically accurate (the site is up and functional) but may be misleading if the team is actively responding to a degradation.

**Current behavior**:

- **OFFLINE** → `POST /api/admin/maintenance` calls `createIncident()` → incident appears on status page → `DELETE /api/admin/maintenance` calls `resolveIncident()` → status page clears
- **DEGRADED** → no incident created, no status page update

**When this matters**: If DEGRADED mode is used to respond to an actual service issue (not just planned maintenance), the status page will not reflect the situation.

**Workaround**: Manually create an incident in the BetterStack dashboard at https://uptime.betterstack.com/team/t332379/incidents if you want the status page to reflect DEGRADED mode.

## Full Route Inventory

### Checkout & Payment Routes

- `POST /api/checkout` -- Create payment intent + initiate booking
- `GET /api/checkout/verify` -- Verify payment completion
- `DELETE /api/checkout/pending/[paymentId]` -- Cancel a PENDING payment and release its tentative slots (#849 cancel-vs-capture guard)

### Appointment Management Routes

- `POST /api/appointments/[id]/cancel` -- Cancel appointment
- `POST /api/appointments/[id]/reschedule` -- Reschedule appointment
- `GET /api/appointments/[id]/documents` -- List documents
- `POST /api/appointments/[id]/documents` -- Upload document
- `GET /api/appointments/[id]/documents/[docId]` -- Get document
- `DELETE /api/appointments/[id]/documents/[docId]` -- Delete document
- `GET /api/appointments/[id]/documents/[docId]/download` -- Download document
- `GET /api/appointments/[id]/documents/consultant` -- Consultant documents

### Event Routes (Consultations)

- `GET /api/bookings/consultations` -- List consultations
- `PATCH /api/bookings/consultations` -- Update consultation status
- `GET /api/bookings/consultations/[id]` -- Get consultation
- `POST /api/bookings/consultations/[id]/allocate` -- Allocate slots
- `GET /api/bookings/consultations/[id]/validate` -- Validate consultation
- `GET /api/bookings/consultations/check-duplicate-title` -- Check duplicates

### Event Routes (Subscriptions)

- `GET /api/bookings/subscriptions` -- List subscriptions
- `POST /api/bookings/subscriptions` -- Create subscription
- `GET /api/bookings/subscriptions/[id]` -- Get subscription
- `POST /api/bookings/subscriptions/[id]/allocate` -- Allocate slots
- `GET /api/bookings/subscriptions/[id]/validate` -- Validate subscription
- `GET /api/bookings/subscriptions/check-duplicate-title` -- Check duplicates

### Event Routes (Webinars)

- `GET /api/bookings/webinars` -- List webinars
- `POST /api/bookings/webinars` -- Create webinar
- `GET /api/bookings/webinars/[id]` -- Get webinar
- `POST /api/bookings/webinars/[id]/allocate` -- Allocate slots
- `GET /api/bookings/webinars/[id]/validate` -- Validate webinar
- `GET /api/bookings/webinars/check-duplicate-title` -- Check duplicates
- `POST /api/bookings/webinars/crud-with-plan` -- Create webinar with plan
- `PATCH /api/bookings/webinars/crud-with-plan/[id]` -- Update webinar with plan

### Event Routes (Classes)

- `GET /api/bookings/classes` -- List classes
- `POST /api/bookings/classes` -- Create class
- `GET /api/bookings/classes/[id]` -- Get class
- `POST /api/bookings/classes/[id]/allocate` -- Allocate slots
- `GET /api/bookings/classes/[id]/validate` -- Validate class
- `GET /api/bookings/classes/check-duplicate-title` -- Check duplicates
- `POST /api/bookings/classes/crud-with-plan` -- Create class with plan
- `PATCH /api/bookings/classes/crud-with-plan/[id]` -- Update class with plan

### Trial Routes

- `GET /api/trials` -- List trials
- `POST /api/trials` -- Create trial
- `GET /api/trials/[id]` -- Get trial
- `POST /api/trials/[id]` -- Update trial
- `GET /api/trials/check-eligibility` -- Check eligibility
- `GET /api/trials/stats` -- Trial statistics

### Participant Routes

- `GET /api/participants/consultations/[id]` -- Consultation participants
- `DELETE /api/participants/consultations/[id]` -- Remove participant
- `GET /api/participants/subscriptions/[id]` -- Subscription participants
- `GET /api/participants/webinar/[id]` -- Webinar participants
- `GET /api/participants/class/[id]` -- Class participants

## The appointment freeze follows the cancellation doctrine (2026-08-14, #1162 / #1169 PR 3)

Entering OFFLINE cancels every appointment overlapping the window through the same machinery as an interactive cancellation, because the old implementation predated that machinery and violated it three ways: it hard-deleted appointments whose only payment was PENDING (cascade-destroying the Payment row the capture webhook then needed), refunded gross amounts through a raw gateway call that could not route org-funded or credit-funded intents, and wrote statuses with no compare-and-swap guard, which could resurrect a COMPLETED booking. The rewrite deletes nothing: event statuses move through the `lib/booking/transitions.ts` CAS helpers (an already-terminal booking is skipped and counted, never resurrected), slots soft-cancel to `completionStatus: CANCELLED` exactly like the cancel route, trials tombstone through `softCancelTrialAppointment`, and open reschedule proposals are closed so `openForAppointmentId` frees. Refunds run after the transactions through `refundBookingPayment`, which clamps to the refundable balance and routes every rail — gateway, org-funded, and referral-credit — and a re-run of the freeze is safe end to end: the CAS guards skip what is already cancelled and the balance clamp turns a second refund attempt into a recorded skip.

Separately, the maintenance-mode Redis keys now carry a 24-hour TTL (#697 INF-1). Every `setMaintenanceState` call refreshes the clock, so a tended window persists, while an OFFLINE flag whose owner disappeared expires back to OFF instead of keeping the platform down indefinitely. Maintenance windows planned to exceed a day must re-assert their phase at least daily; the pre-maintenance checklist carries that rule.
