# Collaborator System — REST API, Lifecycle Sweeps & Transactional Emails

This document specifies all HTTP endpoints, state transitions, background cleanup sweeps, and transactional notification channels governing the collaborator lifecycle.

## Collaborator State Machine

Every state transition on `Collaborator.status` executes an atomic compare-and-swap (`updateMany` with the expected prior state in `WHERE`):

```mermaid
stateDiagram-v2
    [*] --> PENDING : POST invite (Host / Org Admin)
    PENDING --> PENDING : PATCH edit role / share% (Host / Org Admin)
    PENDING --> ACCEPTED : PATCH respond (Invitee)
    PENDING --> DECLINED : PATCH respond (Invitee) / 14d Cron Expiry
    PENDING --> REMOVED : DELETE remove (Host / Org Admin / Ban / Scrub)
    PENDING --> WITHDRAWN : DELETE withdraw (Invitee)
    ACCEPTED --> REMOVED : DELETE remove (Host / Org Admin / Ban / Scrub)
    ACCEPTED --> WITHDRAWN : DELETE leave (Collaborator)
    DECLINED --> PENDING : POST re-invite (Host / Org Admin)
    REMOVED --> PENDING : POST re-invite (Host / Org Admin)
    WITHDRAWN --> PENDING : POST re-invite (Host / Org Admin)
```

---

## REST API Reference

All routes require an authenticated session (`401 Unauthorized` otherwise). API inputs express shares as integer/decimal percentages (`1–90`); API responses return stored basis points (`revenueShareBps`, `100–9000`).

| Method & Endpoint                                       | Caller Authorization                                                                                    | Request Body / Params                                   | Response / Side Effects                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/collaborations`                               | Authenticated user (`?orgScope=<id>&view=org` requires active org `catalog.manage`)                     | Query: `orgScope?`, `view?`                             | Returns `{ webinarCollaborations, classCollaborations, hostedWebinarPlans, hostedClassPlans, hostUser }`                                                                            |
| `GET /api/collaborations/{type}/{planId}`               | Plan owner, org `catalog.manage`, accepted collaborator (`ACCEPTED` list), or pending invitee (own row) | —                                                       | Scoped collaborator list (`404` missing plan, `403` unauthorized)                                                                                                                   |
| `POST /api/collaborations/{type}/{planId}`              | Plan owner or active org `catalog.manage` operator                                                      | `{ consultantProfileId, role, revenueSharePercentage }` | `201 Created`; enforces max 3 active seats, max 1 `PRESENTER`, total `<= 90%`, verified standing, non-attendee check; stages the `INVITED` bell and email in the invite transaction |
| `PATCH /api/collaborations/{type}/{planId}/{id}`        | Plan owner or active org `catalog.manage` operator                                                      | `{ role?, revenueSharePercentage? }`                    | Updates **only `PENDING` rows** (`409` on `ACCEPTED` terms); re-validates presenter cap & `90%` share ceiling inside `Serializable` tx                                              |
| `DELETE /api/collaborations/{type}/{planId}/{id}`       | Plan owner / org admin (`-> REMOVED`) OR own collaborator (`-> WITHDRAWN`)                              | —                                                       | CAS state flip + cancels shadow `AppointmentParticipant` + revokes Stream Chat & live Video SFU + stages the `REMOVED` or `WITHDRAWN` bell and email in the same transaction        |
| `PATCH /api/collaborations/[id]/respond`                | Invited consultant (`consultantProfileId === callerProfile.id`)                                         | `{ response: "ACCEPTED" \| "DECLINED", planType }`      | Re-runs eligibility gates on `ACCEPTED`, writes shadow participant rows, reconciles `collab-*` channel, stages the `ACCEPTED`/`DECLINED` bell and email in the response transaction |
| `GET /api/collaborations/{type}/{planId}/revenue-split` | Plan owner, org operator, accepted collaborator, or staff                                               | `?amount=<paise>` (default `10000`)                     | Preview array of per-party gross slices (`[{ consultantProfileId, organizationId?, share, role }]`)                                                                                 |

---

## Background Sweeps & Double-Booking Guard

### 1. 14-Day Stale Invitation Expiration Sweep (`expireStaleCollaboratorInvites`)

Registered in `lib/cron/cleanup-registry.ts` under Postgres `withCronLock`:

- Scans `Collaborator` rows where `status = 'PENDING'` and `updatedAt < now - 14d`.
- Transitions each stale row in its own transaction via conditional CAS `updateMany({ where: { id, status: "PENDING", updatedAt: { lt: cutoff } }, data: { status: "DECLINED", respondedAt: now } })` (`PENDING --> DECLINED`), immediately freeing the reserved `revenueShareBps` capacity and `PRESENTER` slot on the parent plan.
- Stages, in that same transaction, one `collaborator-invite-expired` bell for the invitee and the inviter or plan host (`invitedBy ?? plan.consultantProfile`) and an `EXPIRED` email to each, then attempts them after commit.

### 2. Co-Host Double-Booking Guard (`lib/collaborators/availability.ts`)

Whenever a host creates or reschedules webinar slots or class batches (the allocator in `lib/booking/allocation`, webinar/class CRUD routes):

- `assertCollaboratorsAvailable()` and `assertCollaboratorsAvailableForWindows()` check every `ACCEPTED` collaborator's confirmed and live-checkout commitments across all owned and collaborated plans.
- Rejects overlapping sessions inside the scheduling transaction with `CollaboratorUnavailableError` (`409 Conflict`) naming the conflicting co-host(s).

---

## Lifecycle Notices (`lib/collaborators/notifications.ts`) & Reminder Fan-Out

Every transition stages its notice inside the transaction that moves the row: `stageCollaboratorNotifications(tx, event, row)` stages one bell through `stageBell` (so the recipient's In-App and Appointments switches apply) and one `CollaborationLifecycleEmail` per recipient through `stageCollaboratorLifecycleEmail` (`lib/email/senders/collaborators.ts`, category-free like before, passing the `EMAIL_DELIVERY_MODE` guard). The caller attempts both with `flushNotificationsAfter` after commit; anything left waits for the relays.

| Event       | Staged by                                                                                  | Recipient                   |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| `INVITED`   | `inviteCollaborator`                                                                       | Invited consultant          |
| `ACCEPTED`  | `respondToInvitation`                                                                      | Plan owner (else inviter)   |
| `DECLINED`  | `respondToInvitation`                                                                      | Plan owner (else inviter)   |
| `REMOVED`   | `removeCollaborator` by the owner                                                          | Removed collaborator        |
| `WITHDRAWN` | `removeCollaborator` by the collaborator, `removeCollaboratorStanding`, org member removal | Plan owner (else inviter)   |
| `EXPIRED`   | `expireStaleCollaboratorInvites`                                                           | Invitee and inviter or host |

A standing removal (ban, erasure, account deletion) names the collaborator only as "A collaborator". An org member removal stages only the host's `WITHDRAWN` per row, because the member already receives the org removal notice. The bell is keyed on the row id, the event and `updatedAt`, so a re-invite after a decline rings again while a replay of one transition does not.

### Appointment Reminder Fan-Out

`sendAppointmentReminders` (`scripts/appointments/send-appointment-reminders.ts`) spreads `collaboratorUserIds(planType, planId)` into every reminder notification alongside the host and paid learners, deduplicating per window using `appointment:${appointmentId}:${windowLabel}` (`24h` vs `1h`) so staging the `24h` reminder never suppresses the `1h` reminder.

---

## Deprecated & Superseded Approaches

- **Post-commit lifecycle sends** (`notifyCollaborator*`, `sendCollaborator*Email`, and the `REMOVED` bell `revokeCollaboratorAccess` sent by default) could be lost when the instance froze after the response, and an org member removal sent both `REMOVED` and `WITHDRAWN` for the same row. Replaced by staging inside the transition's transaction (notification decision 17).
- **Appointment-Scoped Reminder Deduplication Keys (`appointment:${appointmentId}`)**: Previously omitted the `:${windowLabel}` suffix, causing the `24h` reminder stage row in `FailedEmail` to suppress the subsequent `1h` reminder window. Replaced by `appointment:${appointmentId}:${windowLabel}`.
- **In-Place Term Mutation / Re-Consent on `ACCEPTED` Rows**: Flipping an `ACCEPTED` row back to `PENDING` on `PATCH` dropped the collaborator from settlement queries until they re-accepted, diverting their revenue share to the host. Replaced by locking `ACCEPTED` terms (`409 Conflict`).
- **Indefinite `PENDING` Share Reservation**: Previously `PENDING` invitations never expired, permanently locking up to `90%` of a plan's collaborator share budget if an invitee ignored their dashboard. Replaced by the 14-day `expireStaleCollaboratorInvites` sweep.
- **Standalone Advisory Availability Overlay Endpoint (`GET /api/collaborators/[id]/availability`)**: Removed in favor of server-enforced transaction-level conflict detection (`assertCollaboratorsAvailable`).
