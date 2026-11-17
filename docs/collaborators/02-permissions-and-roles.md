---
title: Collaborators — permissions and roles
type: reference
status: live
last-reviewed: 2026-11-17
---

# Collaborators: permissions and roles

This page answers three questions: who may change a plan's team, what each audience is shown, and what each role may do in the live room and in chat. Every answer is derived from the `Collaborator` row at the time of the request; nothing is cached on the user.

## Who the caller is

`resolveCollaborationViewer(db, ref, userId)` in `lib/collaborators/viewer.ts` is the one place that decides what a signed-in user is to a plan's team. Routes never repeat the check. It returns one of five kinds:

| Kind        | Who                                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manager`   | Via `owner`: the plan has an owning expert and it is the caller. On an organisation's plan the owner must also be an active expert member of that organisation (`isActiveOrgExpert`). Via `org`: the caller holds an active membership of the plan's organisation with `catalog.manage`. |
| `presenter` | The caller holds the plan's accepted `PRESENTER` row.                                                                                                                                                                                                                                    |
| `crew`      | The caller holds an accepted `CREW` row on the plan.                                                                                                                                                                                                                                     |
| `invitee`   | The caller holds a `PENDING` row on the plan.                                                                                                                                                                                                                                            |
| `none`      | Anyone else.                                                                                                                                                                                                                                                                             |

A manager also carries `canWrite`. It is true on a personal plan, and on an organisation's plan only while the organisation is `ACTIVE`. An organisation that is not active can be read by its managers and not changed; a `DEACTIVATED` organisation has no manager at all. `requireManager` (`lib/api/collaborations/http.ts`) turns both into a 403 `FORBIDDEN` with a sentence that says which.

The owner comparison only ever matches a plan that has an owning expert, so a plan owned by an organisation alone is managed through the `org` path and by nobody else. An operator who has no expert profile can invite; the row then records no inviting profile (`invitedById` is null).

## Who sees what

| Audience                 | Team list                                                             | Shares                           | Attendee list and attendance | What an attendee paid |
| ------------------------ | --------------------------------------------------------------------- | -------------------------------- | ---------------------------- | --------------------- |
| Manager                  | Every live row: invitations and the team.                             | Every share.                     | Yes                          | Yes                   |
| Presenter                | Their own row and the accepted team.                                  | Their own. A peer's is withheld. | Yes                          | No                    |
| Crew                     | Their own row and the accepted team.                                  | Their own. A peer's is withheld. | No                           | No                    |
| Invitee                  | Their own invitation and the accepted team, never another invitation. | Their own. A peer's is withheld. | No                           | No                    |
| Any other signed-in user | Refused with 403.                                                     | None                             | No                           | No                    |
| The public and learners  | Accepted collaborators' role and public profile.                      | None                             | No                           | No                    |

What enforces each column:

- **Team list and shares.** `projectTeamForViewer` builds the list for the caller's kind from one select (`COLLABORATOR_VIEW_SELECT`), which carries a name and a picture and no contact detail. `toManagerView` keeps every share; `toTeamView` keeps the caller's own and sets a peer's `revenueShareBps` to `null`. A withheld share is `null`, never `0`, so a screen cannot mistake "not shown" for "nothing". A pending row also carries `expiresAt`, the time it lapses.
- **Attendee list and attendance.** `seesAttendees(viewer)` is true for a manager and a presenter. The attendance route (`app/api/appointments/[appointmentId]/occurrences/[occurrenceId]/attendance/route.ts`) answers "not found" to anyone else on the team.
- **Attendee payments.** `seesAttendeePayments(viewer)` is true for a manager only. The appointment detail route (`app/api/scheduling/appointments/[appointmentId]/route.ts`) returns every row to a manager, seats without payments to a presenter, and neither to crew.
- **Public pages.** The public plan loaders select `planCollaboratorScalars` (`lib/api/plans/consultant-projection.ts`): the row's id and role beside the expert's public profile fields. No share, no inviter and no timestamp leaves the server on a public response.

## What each role may do

The labels and the "can" lines the screens and emails show come from `ROLE_INFO` in `lib/collaborators/roles.ts`; no other label map exists. The table below is what the gates do.

| Role                                                    | Group         | In the live room, on joining                                                              | Host controls (record, end for everyone) | Session chat         | Team chat | Learners may message them directly |
| ------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------- | --------- | ---------------------------------- |
| `CO_HOST`, `CO_INSTRUCTOR`                              | Presenter     | Call role `co_presenter`; publishes audio, video and screen.                              | Yes                                      | Member and moderator | Member    | Yes                                |
| `GUEST_SPEAKER`, `GUEST_LECTURER`, `TEACHING_ASSISTANT` | Speaking crew | Call role `call_member`; publishes audio, video and screen.                               | No                                       | Member               | Member    | No                                 |
| `MODERATOR`                                             | Support crew  | Call role `call_member`; joins as an attendee, publishing nothing until brought on stage. | No                                       | Member and moderator | Member    | No                                 |
| `TECHNICAL_SUPPORT`, `CONTENT_CREATOR`                  | Support crew  | Call role `call_member`; joins as an attendee, publishing nothing until brought on stage. | No                                       | Member               | Member    | No                                 |

What enforces each column:

- **The room.** `resolveMeetingAccess` (`lib/meetings/access.ts`) reads the caller's accepted row for the session's plan and grants a presenter the `host` meeting role and crew the `participant` role. The join route (`app/api/meetings/[meetingId]/join/route.ts`) then writes the call role and the publishing permissions shown. The details are in [05 — Stream video](05-stream-video-integration.md).
- **Brought on stage.** The stage route (`app/api/meetings/[meetingId]/stage/route.ts`) accepts a member of the plan's current team as its target, so a host can give support crew the floor the way they would an attendee.
- **Session chat.** Every accepted collaborator is a member of each of the plan's event channels. Presenters and the moderator role also receive Stream's `channel_moderator` role there (`MODERATOR_COLLABORATOR_ROLES` in `lib/stream/event-channel-service.ts`).
- **Team chat.** The plan's `collab-` channel holds the host and every accepted collaborator. See [04 — Stream chat](04-stream-chat-integration.md).
- **Direct messages.** A learner with a seat may open a direct message with the host or the plan's presenter; crew are not offered.
- **Nobody on a team is a learner.** A collaborator holds no seat, is not counted against capacity, and cannot be invited or accept while they hold a learner's seat on the plan (`assertHoldsNoSeat`, refusal `HOLDS_A_SEAT`).

No collaborator of any role can change the plan, its price, its schedule or its team. Those belong to the manager.

## Joining a team

An expert can be invited, and can accept, only while all of the following hold. `readStanding` and the checks around it in `lib/collaborators/service.ts` run inside the invite transaction and again inside the accept transaction, because standing can change between the two.

- The plan exists and is not archived (`PLAN_ARCHIVED`).
- The expert is not the plan's host and is not the person sending the invitation.
- Their profile exists, is not deleted, and their account is not erased.
- Their profile is verified.
- Their account is not under a ban that is in force. A suspension that has run out no longer counts.
- They are resident in India for tax purposes, because earnings cannot yet be paid to a non-resident.
- They hold no learner's seat on the plan.

At invite, every standing failure gives the inviter the same answer, 400 `INVITEE_INELIGIBLE` with "This expert cannot be invited right now", so an invitation reveals nothing about another expert's account. At accept, the invitee is told the actual reason about their own account (`INVITEE_INELIGIBLE` or `NOT_PAYABLE`).

A missing payout account does not block either step. The Collaborations page warns the expert on the invitation and on the accepted card that earnings cannot be paid out until one is verified (`payoutAccountReady` from `getMyCollaborations` in `lib/collaborators/queries.ts`).

## Standing

A collaborator who loses the standing above after joining is taken off every team, and every invitation they hold is withdrawn. Each path calls `endCollaborationsForUser` (`lib/collaborators/ending.ts`) inside its own transaction, which ends each live row as `REMOVED` through the one ending function, so the Stream revocation is owed in the same commit.

| Event                                                       | Where                                                        | `endedByUserId`      |
| ----------------------------------------------------------- | ------------------------------------------------------------ | -------------------- |
| A permanent ban                                             | `lib/moderation/side-effects.ts` (`USER_BANNED`)             | The staff member     |
| A profile un-verified by moderation                         | `lib/moderation/side-effects.ts` (`PROFILE_UNVERIFIED`)      | The staff member     |
| Erasure                                                     | `lib/compliance/erasure/scrub-user.ts`                       | null                 |
| Account deletion                                            | `app/api/user/[id]/route.ts`                                 | null                 |
| The expert deactivates or deletes their own profile         | `app/api/user/consultants/[id]/route.ts`                     | The expert           |
| Removal from an organisation, for that organisation's plans | `endOrgCollaborations` in `lib/enterprise/member-removal.ts` | Whoever removed them |

A suspension with an end date is not on the list. The account cannot sign in while it runs and keeps its place on every team, so the terms it agreed survive a sanction that expires.

Erasure records the Stream access to take back in its own outbox, which covers everything the erased user held, so it tells the ending function not to write a second order (`ownRevocationQueue`).

## Deprecated & Superseded Approaches

- **Three copies of the owner and organisation check** (in the member handlers, the plan route and the list query). Replaced by `resolveCollaborationViewer`.
- **Peers shown with a share of zero.** Replaced by a withheld (`null`) share.
- **Crew joining with full publishing rights, or all crew joining muted.** Replaced by the speaking and support split.
- **Ending collaborations on any suspension.** Only a permanent loss of standing ends them.
- **`assertInviteeEligible` and `assertNotAttendee`.** Replaced by `readStanding` and `assertHoldsNoSeat`, which answer with a `CollaborationError`.
