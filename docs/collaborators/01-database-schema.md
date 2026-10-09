# Collaborator System — Database Schema & Sidecar Constraints

All collaborator state, participant shadow links, and multi-party settlement accruals reside in PostgreSQL with integer basis-point (`Int`) shares and integer paise (`BigInt`) money amounts.

## Entity-Relationship Diagram

```mermaid
erDiagram
    WebinarPlan ||--o{ Collaborator : "webinarPlanId"
    ClassPlan ||--o{ Collaborator : "classPlanId"
    ConsultantProfile ||--o{ Collaborator : "consultantProfileId"
    ConsultantProfile ||--o{ Collaborator : "invitedById (SetNull)"
    WebinarPlan ||--o{ Webinar : "events"
    ClassPlan ||--o{ Class : "batches"
    Appointment ||--o{ AppointmentParticipant : "CONSULTEE | COLLABORATOR"
    Payment ||--o{ ConsultantEarnings : "OWNER | COLLABORATOR"
    Payment ||--o{ OrganizationEarnings : "OWNER | COLLABORATOR"
```

---

## The `Collaborator` Table

Defined in `prisma/schema.prisma`, each `Collaborator` record binds one invited `ConsultantProfile` to either one `WebinarPlan` or one `ClassPlan`.

| Column                | PostgreSQL / Prisma Type                   | Nullable | Default      | Invariant / Purpose                                                                                                                                                |
| --------------------- | ------------------------------------------ | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | `String` (`@id @default(cuid())`)          | No       | `cuid()`     | Unique primary key                                                                                                                                                 |
| `consultantProfileId` | `String`                                   | No       | —            | Invited consultant (`ON DELETE CASCADE`)                                                                                                                           |
| `collaboratorType`    | `CollaboratorType` (`WEBINAR` \| `CLASS`)  | No       | —            | Discriminator matching the populated plan foreign key                                                                                                              |
| `webinarPlanId`       | `String?`                                  | Yes      | `null`       | Set iff `collaboratorType = WEBINAR` (`ON DELETE CASCADE`)                                                                                                         |
| `classPlanId`         | `String?`                                  | Yes      | `null`       | Set iff `collaboratorType = CLASS` (`ON DELETE CASCADE`)                                                                                                           |
| `role`                | `CollaboratorRole`                         | No       | —            | Domain role within the webinar or class subset                                                                                                                     |
| `tier`                | `CollaboratorTier` (`PRESENTER` \| `CREW`) | No       | —            | Capability tier deterministically derived via `tierForRole(role)`                                                                                                  |
| `revenueShareBps`     | `Int`                                      | No       | —            | Gross share in basis points (`100` = `1%`, `9000` = `90%`)                                                                                                         |
| `status`              | `CollaboratorStatus`                       | No       | `PENDING`    | Invitation lifecycle state (`PENDING`, `ACCEPTED`, `DECLINED`, `REMOVED`, `WITHDRAWN`)                                                                             |
| `invitedById`         | `String?`                                  | Yes      | `null`       | Inviting consultant profile (`ON DELETE SET NULL`); `null` when invited by an org operator without a personal consultant profile or after inviter profile deletion |
| `respondedAt`         | `DateTime?`                                | Yes      | `null`       | Timestamp when invitee accepted or declined (or when expired via the 14-day stale invite sweep)                                                                    |
| `createdAt`           | `DateTime`                                 | No       | `now()`      | Initial collaboration row creation timestamp                                                                                                                       |
| `updatedAt`           | `DateTime`                                 | No       | `@updatedAt` | Last state transition timestamp (used as the `updatedAt < now - 14d` cutoff by the 14-day stale invite sweep)                                                      |

---

## Enumerations

```prisma
enum CollaboratorType {
  WEBINAR
  CLASS
}

enum CollaboratorTier {
  PRESENTER
  CREW
}

enum CollaboratorStatus {
  PENDING
  ACCEPTED
  DECLINED
  REMOVED
  WITHDRAWN
}

enum CollaboratorRole {
  // Webinar roles
  CO_HOST
  MODERATOR
  GUEST_SPEAKER
  TECHNICAL_SUPPORT
  // Class roles
  CO_INSTRUCTOR
  TEACHING_ASSISTANT
  GUEST_LECTURER
  CONTENT_CREATOR
}

enum EarningRole {
  OWNER
  COLLABORATOR
}
```

---

## Sidecar SQL Constraints & Indexes

Because Prisma schema syntax cannot express exclusive-OR foreign keys or partial conditional unique indexes, `prisma/sql/check-constraints.sql` enforces critical invariants directly at `COMMIT`:

| Constraint / Index Name                              | SQL Definition                                                                                                   | Purpose                                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `collaborator_plan_xor`                              | `CHECK (("webinarPlanId" IS NULL) <> ("classPlanId" IS NULL))`                                                   | Prevents orphan rows (`NULL/NULL`) and dual-parent rows (`non-NULL/non-NULL`); mirrored in JS by `assertCollaboratorPlanXor()` |
| `Collaborator_consultantProfileId_webinarPlanId_key` | `UNIQUE ("consultantProfileId", "webinarPlanId")`                                                                | Ensures at most one collaboration record per `(consultant, webinarPlan)`; re-inviting re-activates retired rows                |
| `Collaborator_consultantProfileId_classPlanId_key`   | `UNIQUE ("consultantProfileId", "classPlanId")`                                                                  | Ensures at most one collaboration record per `(consultant, classPlan)`                                                         |
| `collaborator_one_presenter_webinar`                 | Partial unique index on `("webinarPlanId")` where `"tier" = 'PRESENTER' AND "status" IN ('PENDING', 'ACCEPTED')` | Guarantees at most one active `PRESENTER`-tier collaborator (`CO_HOST`) per webinar plan                                       |
| `collaborator_one_presenter_class`                   | Partial unique index on `("classPlanId")` where `"tier" = 'PRESENTER' AND "status" IN ('PENDING', 'ACCEPTED')`   | Guarantees at most one active `PRESENTER`-tier collaborator (`CO_INSTRUCTOR`) per class plan                                   |

---

## Related Tables Across Bookings & Settlement

### 1. `AppointmentParticipant` Shadow Rows

When a collaborator accepts an invitation (or when new sessions are scheduled under a plan with accepted collaborators), an idempotent shadow participant row is written on each live `Appointment`:

- `role: "COLLABORATOR"`, `status: "CONFIRMED"`
- Never linked to a `Payment` row
- Excluded from learner seat capacity checks (`role: "CONSULTEE"` counts only paid learners)
- Transitioned to `status: "CANCELLED"` automatically when the collaborator withdraws, is removed, is banned, or is erased

### 2. `ConsultantEarnings` & `OrganizationEarnings`

At payment confirmation, multi-party splits fan out across `ConsultantEarnings` and `OrganizationEarnings`:

- `ConsultantEarnings` enforces `@@unique([paymentId, consultantProfileId, role])`, allowing one `OWNER` row plus up to three `COLLABORATOR` rows on a single `paymentId`.
- `OrganizationEarnings` enforces `@@unique([paymentId, organizationId, role])` / per-party rows so an organization-owned catalog plan (`role: OWNER`) and an org-affiliated collaborator (`role: COLLABORATOR`) accrue independently on the same `paymentId`.
- On **ownerless organization catalog plans** (`WebinarPlan.consultantProfileId = null` or `ClassPlan.consultantProfileId = null`), the `OWNER` split has `consultantProfileId: null` and writes solely to `OrganizationEarnings` + `ORG_PAYABLE`, skipping a null-profile `ConsultantEarnings` write cleanly.

---

## Deprecated & Superseded Approaches

- **Separate `WebinarCollaborator` and `ClassCollaborator` Tables**: Replaced by the unified `Collaborator` table with `collaboratorType` and `collaborator_plan_xor`.
- **`PRESENTER` Value Inside `CollaboratorRole`**: `PRESENTER` belongs exclusively to `CollaboratorTier` (`PRESENTER` vs `CREW`); the domain roles on `CollaboratorRole` are `CO_HOST` (webinar) and `CO_INSTRUCTOR` (class).
- **Float `revenueShare` & Boolean Permission Columns**: Replaced floating-point percentages with integer `revenueShareBps` (`Int`) and replaced `canApprovePayment`, `canViewAnalytics`, `canEditEvent`, `canSeeAttendees` with deterministic `tier: CollaboratorTier`.
- **`ON DELETE CASCADE` on `invitedById`**: Changed to `ON DELETE SET NULL` (`invitedById String?`) so org admin invitations without a consultant profile and deleted inviter profiles never wipe out active collaborations or crash `PendingInvitationCard`.
