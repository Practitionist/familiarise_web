# DEGRADED vs OFFLINE: Phase Comparison

## Summary

| Aspect              | DEGRADED                                          | OFFLINE                                          |
| ------------------- | ------------------------------------------------- | ------------------------------------------------ |
| **Purpose**         | Non-critical work, config changes, cosmetic fixes | DB migrations, schema changes, major deployments |
| **User experience** | Warning banner, site fully functional             | Full maintenance page, all navigation blocked    |
| **Banner**          | Yellow dismissible banner at top                  | Full-screen maintenance page with auto-refresh   |
| **BetterStack**     | No incident created                               | Auto-creates incident                            |

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

| Route Category                                           | DEGRADED                                | OFFLINE                    | Risk Level |
| -------------------------------------------------------- | --------------------------------------- | -------------------------- | ---------- |
| **Webhooks** (`/api/webhooks/*`)                         | Exempt -- always processed              | Exempt -- always processed | Low        |
| **Health** (`/api/health`)                               | Exempt -- always responds               | Exempt -- always responds  | None       |
| **Auth** (`/api/auth/*`)                                 | Exempt -- always works                  | Exempt -- always works     | None       |
| **Maintenance API** (`/api/admin/maintenance`)           | Exempt                                  | Exempt                     | None       |
| **Checkout** (`/api/checkout`, `/api/checkout/verify`)   | Allowed (gap)                           | Blocked (503)              | HIGH       |
| **Cancel appointment** (`/api/appointments/[id]/cancel`) | Allowed (gap)                           | Blocked                    | MEDIUM     |
| **Reschedule** (`/api/appointments/[id]/reschedule`)     | Allowed (gap)                           | Blocked                    | MEDIUM     |
| **Documents** (`/api/appointments/[id]/documents`)       | Allowed                                 | Blocked                    | LOW        |
| **Consultations** (`/api/events/consultations`)          | GET: Allowed, POST/PATCH: Allowed (gap) | Blocked                    | HIGH       |
| **Subscriptions** (`/api/events/subscriptions`)          | GET: Allowed, POST: Allowed (gap)       | Blocked                    | HIGH       |
| **Webinars** (`/api/events/webinars`)                    | GET: Allowed, POST: Allowed (gap)       | Blocked                    | MEDIUM     |
| **Classes** (`/api/events/classes`)                      | GET: Allowed, POST: Allowed (gap)       | Blocked                    | MEDIUM     |
| **Allocate slots** (`/api/events/*/allocate`)            | Allowed (gap)                           | Blocked                    | HIGH       |
| **Validate** (`/api/events/*/validate`)                  | Allowed (read-only)                     | Blocked                    | LOW        |
| **Participants** (`/api/participants/*`)                 | Allowed                                 | Blocked                    | LOW        |
| **Trials** (`/api/trials`, `/api/trials/[id]`)           | Allowed (gap)                           | Blocked                    | MEDIUM     |
| **Plans** (`/api/plans/*`)                               | GET: Allowed, POST/PATCH: Allowed (gap) | Blocked                    | MEDIUM     |
| **User routes** (`/api/user/*`)                          | Allowed                                 | Blocked                    | LOW        |
| **Admin routes** (`/api/admin/*`)                        | Allowed                                 | Blocked                    | LOW        |
| **Staff routes** (`/api/staff/*`)                        | Allowed                                 | Blocked                    | LOW        |

### Infrastructure Components

| Component                             | DEGRADED              | OFFLINE                           | Notes                                            |
| ------------------------------------- | --------------------- | --------------------------------- | ------------------------------------------------ |
| **Cron jobs (GitHub Actions)**        | Run normally (gap)    | Run normally (gap)                | Bypass middleware entirely -- run server-side    |
| **Video calls (Stream.io)**           | Active calls continue | Active calls continue (gap)       | Stream infrastructure is external                |
| **Chat (Stream.io)**                  | Works normally        | Works normally (gap)              | Client-side SDK, not routed through middleware   |
| **Email notifications (Novu/Resend)** | Sent normally         | Sent normally                     | External service, not affected                   |
| **File storage (Supabase)**           | Accessible            | API blocked, but direct URLs work | Upload routes blocked, existing files accessible |
| **Redis**                             | Normal operation      | Normal operation                  | Maintenance state stored here                    |
| **PostgreSQL**                        | Normal operation      | May be mid-migration              | This is the critical component during OFFLINE    |

## Current Gaps

### Gap 1: DEGRADED Does Not Block Writes

**Problem**: In DEGRADED mode, the middleware only adds informational headers (`x-maintenance-phase`, `x-maintenance-reason`, `x-maintenance-eta`). All write operations (POST, PATCH, DELETE) proceed normally.

**Impact**: Users can complete checkouts, create appointments, modify events, and perform other transactional operations during DEGRADED mode.

**When this matters**: If DEGRADED is used during a deployment that changes business logic but not the DB schema, writes could produce inconsistent data.

### Gap 2: Cron Jobs Bypass Middleware Entirely

**Problem**: All 27 cron jobs run as standalone Node.js scripts via GitHub Actions. They connect directly to PostgreSQL via Prisma, completely bypassing the Next.js middleware.

**Impact**: During OFFLINE mode (especially DB migrations), cron jobs may:

- Read/write to tables being migrated
- Corrupt data if schema is changing
- Create race conditions with migration scripts
- Cancel valid payment intents (cleanup jobs)

**Affected jobs**: All 27 -- see [Cron Jobs Reference](./04-cron-jobs-reference.md)

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

- `GET /api/events/consultations` -- List consultations
- `PATCH /api/events/consultations` -- Update consultation status
- `GET /api/events/consultations/[id]` -- Get consultation
- `POST /api/events/consultations/[id]/allocate` -- Allocate slots
- `GET /api/events/consultations/[id]/validate` -- Validate consultation
- `GET /api/events/consultations/check-duplicate-title` -- Check duplicates

### Event Routes (Subscriptions)

- `GET /api/events/subscriptions` -- List subscriptions
- `POST /api/events/subscriptions` -- Create subscription
- `GET /api/events/subscriptions/[id]` -- Get subscription
- `POST /api/events/subscriptions/[id]/allocate` -- Allocate slots
- `GET /api/events/subscriptions/[id]/validate` -- Validate subscription
- `GET /api/events/subscriptions/check-duplicate-title` -- Check duplicates

### Event Routes (Webinars)

- `GET /api/events/webinars` -- List webinars
- `POST /api/events/webinars` -- Create webinar
- `GET /api/events/webinars/[id]` -- Get webinar
- `POST /api/events/webinars/[id]/allocate` -- Allocate slots
- `GET /api/events/webinars/[id]/validate` -- Validate webinar
- `GET /api/events/webinars/check-duplicate-title` -- Check duplicates
- `POST /api/events/webinars/crud-with-plan` -- Create webinar with plan
- `PATCH /api/events/webinars/crud-with-plan/[id]` -- Update webinar with plan

### Event Routes (Classes)

- `GET /api/events/classes` -- List classes
- `POST /api/events/classes` -- Create class
- `GET /api/events/classes/[id]` -- Get class
- `POST /api/events/classes/[id]/allocate` -- Allocate slots
- `GET /api/events/classes/[id]/validate` -- Validate class
- `GET /api/events/classes/check-duplicate-title` -- Check duplicates
- `POST /api/events/classes/crud-with-plan` -- Create class with plan
- `PATCH /api/events/classes/crud-with-plan/[id]` -- Update class with plan

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
