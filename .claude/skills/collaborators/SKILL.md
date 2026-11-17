---
name: collaborators
description: Rules for changing the collaborator subsystem — the team of co-presenters and crew on a webinar or class plan. Covers the Collaborator row as the one source of truth (one row per period on a team), the one ending function and its durable Stream revocation, the as-of time every money path passes, the viewer and its projections, the plan lock, the database rules (transition trigger, caps trigger, partial uniques) and the banned patterns. Use when touching lib/collaborators/**, app/api/collaborations/**, lib/api/collaborations/**, lib/stream/collaborator-access.ts, the collaborator helpers in lib/stream/access-revocation.ts, components/collaborators/**, or any code that asks "who is on this plan's team", splits a sale among a team, or ends a collaboration (ban, erasure, deletion, organisation removal).
---

# Collaborators

Design, diagrams and worked examples: `docs/collaborators/00-overview.md` onwards. Decisions and the options not chosen: `docs/decisions/2026-11-16-collaborators.md`. This file is the rule list.

## Where things live

| Module (`lib/collaborators/`) | Holds                                                                                                          | Must not import                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `rules.ts`                    | The numbers (`MAX_COLLABORATORS_PER_PLAN`, `MAX_TEAM_SHARE_BPS`, invite window, cooldown) and their date maths | Anything. Client components import it.                                         |
| `roles.ts`                    | `PRESENTER_ROLES`, `SPEAKING_CREW_ROLES`, `tierForRole`, `ROLE_INFO` (the one label and ability table)         | Anything but Prisma types. Client-imported.                                    |
| `team.ts`                     | `PlanRef`, `planWhere`, `lockPlanRow`, `currentTeam`, `teamAsOf`                                               | Stream, Novu, the service                                                      |
| `viewer.ts`                   | `resolveCollaborationViewer`, `seesAttendees`, `seesAttendeePayments`, the projections                         | The service, Stream, Novu                                                      |
| `queries.ts`                  | Every read for the screens, already projected                                                                  | The service                                                                    |
| `service.ts`                  | The writes: invite, change pending terms, respond, remove, leave; `CollaborationError`                         | A Stream client (it calls `lib/stream/collaborator-access.ts`)                 |
| `ending.ts`                   | `endCollaboration`, `endCollaborationsForUser`, `afterCollaborationEnded`                                      | The service; Stream at module load (it loads `access-revocation` on first use) |
| `cleanup.ts`                  | `expireStaleCollaboratorInvites`                                                                               | The service                                                                    |
| `revenue-split.ts`            | `calculateRevenueSplit`                                                                                        | Anything but `team.ts`                                                         |
| `recipients.ts`               | `collaboratorUserIds`, `collaboratorUserIdsForEvent` for recipient lists                                       | The service, Stream, Novu                                                      |

Stream work: `lib/stream/collaborator-access.ts` (`grantCollaboratorAccess`, `driveCollaboratorRevocation`) and the collaborator helpers in `lib/stream/access-revocation.ts` (`persistCollaboratorRevocationInTx`, `revokeCollaboratorAccess`, `fenceCollaboratorGrant`). Routes: `app/api/collaborations/**` over `lib/api/collaborations/{http,plan-route,member-handlers}.ts`. Bodies and params: `schemas/collaborators.ts`.

## Rules

1. **The `Collaborator` row is the only record of a team.** On the team now: `currentTeam` (`status = ACCEPTED`, profile not deleted). On the team at a time: `teamAsOf(db, ref, at)`. Never derive the team from booking participants, a Stream roster or a cached list.
2. **A row is one period.** An invite always creates a row; an ended row (`DECLINED`, `EXPIRED`, `REMOVED`, `WITHDRAWN`) never changes. Never move an ended row back to `PENDING`, and never update the terms of an `ACCEPTED` row: the database refuses both (`collaborator_transition_guard`).
3. **Never set `acceptedAt` or `endedAt`.** The trigger stamps them from the database clock and overwrites whatever a writer sends. Never read or write `respondedAt` in web code.
4. **End a collaboration only through `endCollaboration(tx, ...)`**, inside the transaction of whatever caused the ending, then call `afterCollaborationEnded(ended, op)` after the commit. For "this user lost their standing" call `endCollaborationsForUser(tx, userId, ...)`. The transaction writes the `COLLAB_REVOKE` intent for anyone who had been accepted; you never call Stream yourself and you never queue a retry after a failure.
5. **Take the plan lock first.** A transaction that changes a plan's team or its session times calls `lockPlanRow(tx, ref)` (schedule writers: `lockPlanAndCheckBatch` or `lockPlanForMove` in `lib/booking/host-slot-batch.ts`) as its first statement, then reads. A Serializable caller must be inside `withSerializableRetry`, because queueing behind the lock fails it with 40001 by design.
6. **Every status change is a conditional write** with the expected status in `WHERE` (`updateMany` / `updateManyAndReturn`), and every query inside a transaction uses `tx`.
7. **Money passes a time, never "now".** `calculateRevenueSplit(ref, amount, db, { at })` requires `at`: the capture time for a seat (the value written to `Payment.capturedAt`), `capturedAt ?? createdAt` for a retry or the earnings sweep, the recorded session's start for a replay. `CreateEarningsParams.teamAt` is required for the same reason. Ending a collaboration writes nothing to earnings.
8. **Decide access with the viewer, and return projections.** Routes call `resolveCollaborationViewer` and `requireManager` (`lib/api/collaborations/http.ts`); they never re-implement the owner or organisation check. Lists go through `projectTeamForViewer`, `toManagerView` or `toTeamView`. A peer's share is `null`, never `0`. Attendee lists: `seesAttendees`. Attendee payments: `seesAttendeePayments`. Public selects use `planCollaboratorScalars`.
9. **Every refusal is a `CollaborationError(code, sentence, detail?)`.** Routes answer through `collaborationErrorResponse` as `{ error, code, ...detail }`. Map a Postgres refusal with `lib/db/pg-errors.ts` (`isUniqueViolation`, `isCheckViolation`); never match on message text. An invite refused for the invitee's standing gives the one sentence in `NOT_INVITABLE`, whatever the reason.
10. **No participant rows for collaborators.** Nothing writes an `AppointmentParticipant` with `role: "COLLABORATOR"`. A reader that counts or admits seats filters on `role: "CONSULTEE"` or spreads `NOT_COLLABORATOR_ROW` (`lib/booking/participants.ts`). When a former collaborator buys a seat, `recordParticipants` takes their old staff row over as a new learner seat; keep that take-over when you change it.
11. **After any Stream grant to a collaborator, call `fenceCollaboratorGrant(ref, userId)`** and honour its answer: `lost` means the grant was taken back, `verified: false` means do not admit.
12. **Names of roles come from `ROLE_INFO`.** Do not add another label map, and do not print an enum value on a screen or in an email.
13. **Report once, with one tag.** `reportSentryError(error, { subsystem: "collaborators", op })`; inside a loop collect failures and report after it.
14. **Parse every body and param with Zod** from `schemas/collaborators.ts`. A share is `sharePercent`, a whole number from 1 to 90; convert with `percentToBps`.

## Banned patterns

- `tx.collaborator.update(...)` or `updateMany` that changes `status` outside `service.ts` and `ending.ts`.
- `collaborator.upsert`, or reusing a row for a second invitation.
- A split, a payout or an earnings repair that reads `currentTeam` or filters `status: "ACCEPTED"`.
- `new Date()` passed as `at` / `teamAt` on a retry path.
- A Stream removal for a collaborator written inline in a route or job in place of `afterCollaborationEnded`.
- An application sweep or assertion that re-checks the team size, the share total or the transition rules; Postgres owns them.
- Importing `lib/collaborators/service.ts` from money, cron or Stream code.
- A server-only import added to `rules.ts`, `roles.ts` or `schemas/collaborators.ts`.

## Verify

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"   # only where node is not on PATH
node_modules/.bin/jest __tests__/collaborators __tests__/payments/collaborator-split-as-of.test.ts \
  __tests__/payments/multi-party-split.test.ts --coverage=false
scripts/dev/db-tier-local.sh /tmp/collab-db.log __tests__/db/collaborators
rg -n "role: \"COLLABORATOR\"" lib app --glob '!**/*.test.*'    # expect one hit: the take-over in recordParticipants, which turns an old staff row into the buyer's learner seat
rg -n "respondedAt" lib/collaborators lib/api/collaborations app/api/collaborations components/collaborators   # expect one hit: the omit in queries.ts
```

Which suite pins which rule, and what the database tier covers: `docs/collaborators/06-api-and-lifecycle.md`, section "Testing".
