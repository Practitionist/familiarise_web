# ADR: A collaboration is one row per period on a plan's team, and access and money are read from it

- **Status**: Accepted (owner decisions, 2026-11-16). Built on the branch that carries this record.
- **Date**: 2026-11-16
- **Author**: Platform engineering
- **Related**: [Collaborator overview](../collaborators/00-overview.md), [Event membership follows seats](2026-11-14-event-membership-follows-seats.md), [Access rules after the bug hunt](2026-11-13-access-rules-after-the-bug-hunt.md), [Conduct removal](2026-11-15-conduct-removal.md), [Channel lifecycle](../stream/17-channel-lifecycle.md)

## Context

A webinar or class plan can carry a small team of other experts: one co-presenter and supporting crew, each with a role and a share of every seat sold. This record fixes how that team is stored, who may change it, what a place on it grants in chat and in the live room, and how a sale is divided among it.

Three questions decide the design, and each needs one answer that every part of the system reads the same way:

1. **Who is on the team, and who was on it at a given time?** Access asks the first question; money asks the second, because a payment can be settled after the team has changed.
2. **What ends a place on the team, and what is owed when it ends?** A removal takes effect in Postgres at once, and the access held on Stream has to follow even if the request dies after its commit.
3. **Who may see what?** A share is a private commercial term between a host and one collaborator.

The vocabulary used below: a **presenter** is the one co-presenter a plan may carry (`CO_HOST` on a webinar, `CO_INSTRUCTOR` on a class). **Speaking crew** are `GUEST_SPEAKER`, `GUEST_LECTURER` and `TEACHING_ASSISTANT`. **Support crew** are `MODERATOR`, `TECHNICAL_SUPPORT` and `CONTENT_CREATOR`. A **manager** is the plan's own expert or an operator of the plan's organisation who holds `catalog.manage`. A share is stored in basis points (`revenueShareBps`, 100 basis points to one percent).

## Decisions

1. **The `Collaborator` row is the one source of truth, and a row is one period on a team.** A row is born `PENDING`, may become `ACCEPTED`, and ends as `DECLINED`, `EXPIRED`, `REMOVED` or `WITHDRAWN`. An ended row never changes again, so inviting the same expert again creates a new row and the earlier periods stay as history.
   - On the team now means `status = ACCEPTED` (`currentTeam` in `lib/collaborators/team.ts`). On the team at time T means `acceptedAt <= T` and `endedAt` is null or later than T (`teamAsOf` in the same file). The answer to the second question is the same whenever it is asked, which is what a payment settled later depends on.
   - The database allows an expert at most one `PENDING` or `ACCEPTED` row per plan (`collaborator_one_active_webinar`, `collaborator_one_active_class` in `prisma/sql/check-constraints.sql`). `inviteCollaborator` (`lib/collaborators/service.ts`) always creates a row.
   - No booking participant row is written for a collaborator. Seat counts and seat readers select learner rows (`role: "CONSULTEE"`), and access gates spread `NOT_COLLABORATOR_ROW` (`lib/booking/participants.ts`) into their filter, so a participant row with the `COLLABORATOR` role opens no room and no chat and counts as nobody.
   - Options not chosen: keeping participant rows as a second copy of the team with a job that reconciles the two; reusing one row across invitations (it loses the earlier period and the terms that were agreed then); a separate history table (the row with its two timestamps already is the history).

2. **Postgres enforces the state machine and the caps for every writer.** The trigger `collaborator_transition_guard` (function `assert_collaborator_transition`) admits only the transitions in decision 1, fixes the role, tier and share once a row leaves `PENDING`, refuses moving a row to another expert or plan, and stamps `acceptedAt` and `endedAt` from the database clock; a writer cannot set either. The trigger `collaborator_plan_caps` (function `assert_collaborator_plan_caps`) locks the plan row and refuses a fourth live row (`collaborator_plan_team_size`) or live shares above 9,000 basis points (`collaborator_plan_share_total`). `collaborator_period_is_coherent` ties each status to the timestamps it must carry. One live presenter per plan is a partial unique index (`collaborator_one_presenter_webinar`, `collaborator_one_presenter_class`).
   - Application code keeps a friendly pre-check that answers with a sentence (`assertTeamHasRoom`) and a conditional update with the expected status in its `WHERE`. It adds no sweep or assertion that re-verifies what the database refuses.
   - Option not chosen: the rules in application code only, which bind one writer and not the next one.

3. **An accept is bound to the terms the invitee saw.** The accept request carries the role and share shown on the card (`seenTerms`), and the update applies only to a row that is still `PENDING` with exactly those terms (`acceptInTx`). If the host changed them, the answer is 409 `TERMS_CHANGED` with the current terms beside it, and the invitee decides again. Accepted terms never change (`TERMS_LOCKED`); the host removes the collaborator and invites them again.
   - Option not chosen: accepting whatever the row holds at the time of the request.

4. **Accepting grants access best effort and then re-checks; there is no accept intent.** After the commit, `grantCollaboratorAccess` (`lib/stream/collaborator-access.ts`) adds the new member to the team chat and to the event chats that exist, then calls `fenceCollaboratorGrant` (`lib/stream/access-revocation.ts`), which re-reads the row and takes the grant back if the collaboration is no longer `ACCEPTED`. If the process dies after the commit, nothing is lost: the collaborator's next channel sync and the join route derive the same access from the row, and each of them runs the same re-check after it writes to Stream.
   - Option not chosen: a durable "grant owed" record for accepts. A missing grant heals on the collaborator's next visit; a missing revocation does not heal by itself, which is why only endings are recorded (decision 5).

5. **Every ending goes through one function and is owed durably.** `endCollaboration` (`lib/collaborators/ending.ts`) runs inside the caller's transaction: the conditional status change, the notices, and, for someone who had been accepted, a `COLLAB_REVOKE` row written by `persistCollaboratorRevocationInTx`. All three commit or roll back together. After the commit, `afterCollaborationEnded` drives the revocation inside a budget of eight seconds (`SYNC_COLLABORATOR_REVOCATION_BUDGET_MS`), re-reads Postgres first and skips the Stream work if the user is on the team again, and settles only the generation its own transaction wrote. Whatever it leaves, the `retry-moderation-enforcement` job finishes; `COLLAB_REVOKE` is one of `UNCAPPED_REVOCATION_KINDS`, so past the attempt cap it keeps retrying daily and never gives up. An invitation that was never accepted held no access, so ending it writes no revocation and makes no Stream call.
   - Options not chosen: calling Stream first and queueing a retry only on failure (a crash between the commit and the queue write loses the obligation); a capped retry.

6. **A pending invitee who leaves has declined.** `leaveCollaboration` records `WITHDRAWN` for a row that was accepted and `DECLINED` for one that was not. `WITHDRAWN` therefore always means someone who had been on the team.

7. **Losing the standing a collaborator needs ends every collaboration as `REMOVED`; a time-limited suspension does not.** `endCollaborationsForUser` ends each invitation and team place a user holds, inside the transaction of the event that took the standing away: a permanent ban and a profile un-verified by moderation (`lib/moderation/side-effects.ts`), erasure (`lib/compliance/erasure/scrub-user.ts`), account deletion (`app/api/user/[id]/route.ts`), and an expert deactivating or deleting their profile (`app/api/user/consultants/[id]/route.ts`). Removal from an organisation ends the member's rows on that organisation's plans (`endOrgCollaborations` in `lib/enterprise/member-removal.ts`). `endedByUserId` names the person who acted and is null when the platform did. A suspension has an end date: the account cannot sign in meanwhile and keeps its place.
   - Option not chosen: ending collaborations on suspension, which would cost a collaborator the terms they agreed for a sanction that expires.

8. **Speaking crew publish on joining; support crew join as attendees.** The join route (`app/api/meetings/[meetingId]/join/route.ts`) gives a presenter the `co_presenter` call role and the publishing permissions, gives speaking crew the same publishing permissions (audio, video and screen share) from the moment they join, and removes the publishing permissions of support crew, who can be brought on stage like any attendee. The Stream call type's grants are unchanged.
   - Option not chosen: a new call role per collaborator role.

9. **Each audience sees a fixed set of fields.** `resolveCollaborationViewer` (`lib/collaborators/viewer.ts`) is the one place that decides who the caller is to a plan's team, and `projectTeamForViewer` builds what they see. A manager sees every live row and every share. A collaborator sees their own share; a peer's share is withheld (`null`), not shown as zero. A presenter sees the attendee list and attendance (`seesAttendees`); what an attendee paid goes to platform staff, to a manager, and to a member of the plan's organisation whose role reads money (owner, maintainer or billing admin: the `audit.read.money` grant), and to nobody else a roster admits, so a support member reads the attendee list without it (`seesAttendeePayments`); crew see neither. Public pages and learners get a collaborator's role and public profile (`planCollaboratorScalars` in `lib/api/plans/consultant-projection.ts`).

10. **A seat is split among the team as of the payment's capture, and removal changes no earning.** `calculateRevenueSplit` (`lib/collaborators/revenue-split.ts`) takes a required time and reads `teamAsOf`. A capture passes the time it writes to `Payment.capturedAt`, inside the capturing transaction. A retry and the earnings sweep pass the capture time the payment row carries, never the current time, so they settle what the first attempt would have. A replay purchase passes the start of the recorded session, so it pays the team that delivered it. Ending a collaboration writes nothing to earnings: seats captured while the collaborator was on the team keep their split, and seats captured afterwards exclude them.
    - Options not chosen: clawing back or pro-rating a removed collaborator's earnings by sessions delivered; splitting by the team at settlement time.

11. **An expert who cannot be paid cannot join a team.** A non-resident expert is refused at invite and at accept (`readStanding` in `lib/collaborators/service.ts`). A missing payout account only warns: the Collaborations page says so and the invitation can still be accepted.

12. **Shares are whole percents from 1 to 90, and a team shares at most 90% between them.** Zod (`sharePercentSchema` in `schemas/collaborators.ts`) and `assertTerms` hold the first rule; the caps trigger holds the second.

13. **Invitations are rate limited, cool down and lapse.** An inviting user may send ten invitations an hour (`collaboratorInviteLimiter`). After a `DECLINED` or `WITHDRAWN` row, the same plan cannot invite that expert for seven days (`REINVITE_COOLDOWN_DAYS`); an `EXPIRED` or `REMOVED` row carries no cooldown. An invitation lapses fourteen days after it was sent or its terms last changed and is recorded as `EXPIRED` (`expireStaleCollaboratorInvites` in `lib/collaborators/cleanup.ts`). The same daily job reminds the invitee once, three days before the lapse; the reminder is claimed with an `IdempotencyRecord` keyed on the row and its `updatedAt`, so a change of terms earns a fresh one and a second run sends nothing.

14. **A sponsored seat pays the stamped fee rate.** When an organisation pays for a seat, each party still pays the platform fee stamped on the order on their own slice. Case 4 of `__tests__/payments/multi-party-split.test.ts` pins it with the real fee module: on a ₹10,000 seat with a 20% collaborator and a 20% stamped fee, the host nets ₹6,400 and the collaborator ₹1,600.

15. **Each change is told to the other party, and those notices are required.** `stageCollaboratorNotifications` (`lib/collaborators/notifications.ts`) stages the bell and emails in the transaction of the change. The invitee hears of an invitation, a change of its terms and a removal; the host side hears of an accept, a decline and a departure; both hear of an expiry. Every one of them carries the required kind `COLLABORATION_CHANGED` (`lib/notifications/required-notices.ts`) and is sent whatever the recipient's switches say. The reminder before a lapse is the one optional notice. The host side is the plan's owning expert, or on a plan with none the organisation's active members who hold `catalog.manage` (`hostSideUserIds`); whoever made the change is left off it.
    - Options not chosen: making every notice optional (a collaborator could miss their own removal); telling whoever sent the invitation in place of the plan's host side.

16. **Learners are told when a plan's named co-presenter changes.** When a presenter is accepted, or one who was on the team leaves or is removed, every user holding a paid seat on one of the plan's live events gets a required notice of kind `COHOST_CHANGED` (`stageCohostChange`). It states the fact and nothing else. Crew changes are not announced. The bell is the required notice and commits with the change. The email is its copy: `sendOwedCohostEmails` stages it after the commit, fifty seat holders to a transaction, once per seat holder and change.
    - Option not chosen: offering a refund with the notice. That is deferred work, below.

17. **Operators get one digest line and one read-only list.** The ops digest counts the `COLLAB_REVOKE` rows still owed and gives the age of the oldest (`revocationSection` in `lib/observability/ops-digest.ts`). Staff with `payouts.read` have a read-only Collaborations page in the back office (`readCollaborations` in `lib/backoffice/collaborations-read.ts`): plan, expert, role, share, status, the period and who ended it. Every report from the subsystem carries the one Sentry tag `collaborators`.
    - Option not chosen: staff actions on a collaboration. Staff act on the people and the money through the screens that already exist.

18. **The expert named on an organisation's plan manages it only while an active expert member of that organisation, on every managing surface.** The rule the plan edit routes already keep ([access rules after the bug hunt](2026-11-13-access-rules-after-the-bug-hunt.md), decision 2) has one definition in `lib/enterprise/membership-guards.ts`: `managedAsNamedExpertWhere` as a query filter and `managesGroupPlanAsNamedExpert` for one booking, both built on the same membership fragment as `activeOrgExpertWhere`. It gates the collaborator routes (through `resolveCollaborationViewer`), the roster read and the organiser's removal of an attendee, removal for conduct, the roster and payments on the appointment detail, the group-event gate that guards event reads and changes, the event's slot reads, the planner's lists and the hosted-plans list on the Collaborations page. A personal plan reads no membership, and an organisation operator's rights are unchanged.
    - The expert's Appointments list stays a record of what they delivered: it lists an organisation plan's sessions whatever their standing, and an expert who has left still opens such a session's page, without its roster or its attendees' payments.
    - Option not chosen: hiding upcoming sessions of the plan from an expert who has left. That separates upcoming rows from delivered ones in a list that is one history today, and it waits on a product decision.

## Defaults the build chose

The owner was not asked about these; each is small and can change without a redesign.

- Team changes on one plan queue behind a row lock on the plan (`lockPlanRow` in `lib/collaborators/team.ts`), taken as the first statement of the transaction. Schedule writers take the same lock before they read the team (`lockPlanAndCheckBatch` in `lib/booking/host-slot-batch.ts`).
- An invite and a change of pending terms run at Read Committed behind that lock. An accept runs Serializable inside `withSerializableRetry` and answers 409 `CONFLICT` when its attempts run out.
- A manager of an organisation that is not active may read its plans' teams and may not change them; a deactivated organisation has no manager (`canWrite` in `resolveCollaborationViewer`).
- An invite refused for the invitee's standing gives one answer for every reason ("This expert cannot be invited right now"), so it tells the inviter nothing about another expert's account.
- An invitation is refused while the invitee holds a learner's seat on the plan (`HOLDS_A_SEAT`), and a buyer who is also on the team earns no share of their own seat.
- Speaking crew do not share a screen on joining (decision 8).
- `Collaborator.respondedAt` stays as a column the database maintains. Web code neither reads nor writes it; the mobile backend reads `respondedAt`.
- The participant role value `COLLABORATOR` stays in the enum, and rows that carry it stay as inert history.
- `endedByUserId` records who ended a collaboration.
- On an accept, the collaborator is emailed their own copy of the terms beside the host side's notice.
- A manager who ends their own row is told to the host side as having left or declined, never as removed.
- When an account loses its standing, the host side hears that a collaborator left, without a name.
- Going live stays with the host; a presenter can record and end a session.

## Limits that remain

- The capture time is the application's clock, and `acceptedAt` and `endedAt` are the database's clock at the moment of the status change. A removal and a capture within the same moment can fall either side of each other, and a first attempt that ran before the removal committed can include a collaborator whom a retry of the same capture, reading the committed end time, leaves out.
- A collaborator whose profile is erased between a capture and its retry takes no slice in the retry; the plan's owner keeps the remainder.
- A capture recovered by staff that carries no capture time is split as of the payment's creation.
- The in-call meeting extension changes a session's end outside any transaction and does not take the plan lock.
- Freedom from deadlock between schedule writers and the accept rests on the lock order (calendar hold, then the plan row, then the collaborator row); it is argued, and no test with two real sessions exercises it.
- The learners' emails are staged after the commit, so a crash in that instant loses the email and keeps the bell.
- Notices staged by a ban or an erasure are delivered by the notification outbox on its schedule, not attempted at once.
- The accept email shows the share on a fixed example seat of ₹1,000, not on the plan's price. The screens' rupee example is each party's slice of the listed price before the platform fee, with a sentence that the fee then comes off each share.
- On the screens: a plan with no collaborator does not appear on the Collaborations page, so its first invitation starts from the plan editor; the hosted cards always show the manage controls, so an operator of an organisation that is not active learns from the refusal; the host can find themself in the expert search and the server refuses the invitation; there is no sidebar badge for pending invitations and no list of ended collaborations.
- Browser code imports `schemas/collaborators`, `lib/collaborators/roles.ts`, `lib/collaborators/rules.ts` and the money formatting helper; only a production build proves none of them pulls server code into the bundle.

## Open questions

Nothing in this change alters how tax is deducted or invoiced. These questions are open and none of them is answered in code.

For a chartered accountant:

1. Is each collaborator an e-commerce participant with their own gross amount and threshold, or is the host the only participant?
2. Is the base for tax deducted at source the gross slice or the slice after the platform fee, and is GST excluded when deducting at credit?
3. When is a collaborator's share credited: at the sale, at each delivered session, or at release from hold?
4. Do the circulars that govern deduction by an e-commerce operator still apply under the Income-tax Act, 2025?
5. How is a deduction corrected when a share is reversed and the collaborator has no later transaction in the same year?
6. For GST, who is the supplier of record for a jointly delivered class, who invoices the learner, and is the share passed between experts a taxable supply?
7. How do tax collected at source and credit notes work per supplier on a split sale and on a partial refund?
8. Do experts who sell only through the platform and are under the turnover threshold need GST registration?

For counsel:

1. The collaborator agreement: removal without cause, payment for delivered sessions, notice, and whether the platform decides disputes.
2. What a learner is owed when a named co-instructor is removed mid-series.
3. How long the platform may hold a payee's earnings before their payout account is verified.
4. The wording of the learners' notice when a named co-presenter changes, before launch.

## Deferred work

Each of these is tracked as its own issue and none is built here.

- Moving part of an earning from one expert to another, which waits on the accountant's answer about correcting a deduction.
- Collaborations in the mobile app through the web service, and retiring `respondedAt` with it.
- In-call moderation powers for the moderator role.
- The promotional-price floor when a party settles on an organisation's rate card.
- Routing a collaborator's slice through their organisation membership on a personal collaboration.
- Re-reading the buyer's team membership inside the checkout commit.
- Offering a learner a pro-rated refund when a named co-presenter changes.
- Removing the `COLLABORATOR` participant role value.

## Deprecated & Superseded Approaches

- **Staff participant rows as a mirror of the team.** Accepting used to write a booking participant row per event for the collaborator, and gates read those rows. Superseded by reading the `Collaborator` row everywhere (decision 1); delete any writer of a `COLLABORATOR` participant row on sight.
- **One row per expert per plan, reset on re-invite.** Superseded by one row per period.
- **`removeCollaboratorStanding` and per-path ending code.** Superseded by `endCollaboration` and `endCollaborationsForUser`.
- **`enqueueCollaboratorRevocationRetry` after a failed Stream call.** Superseded by the intent written in the ending transaction.
- **Setting the call role at accept time (`syncOpenCallPresenterRole`).** Superseded by the join route, which derives the role from the row.
- **`calculateRevenueSplit` reading the current team.** Superseded by the required as-of time.
- **`revenueSharePercentage` in request bodies, and `planType` in the respond body.** Superseded by `sharePercent` and by reading the plan from the row.
