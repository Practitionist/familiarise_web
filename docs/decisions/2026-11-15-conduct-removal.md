# ADR: Hosts remove attendees for conduct, and support reviews it within 72 hours

- **Status**: Accepted (owner decisions, 2026-11-15). Built on the branch `feat/conduct-removal`.
- **Date**: 2026-11-15
- **Author**: Platform engineering
- **Related**: [Event membership follows seats](2026-11-14-event-membership-follows-seats.md), [Cancellation flow](../booking/08-cancellation-flow.md), [SLA sweep](../support/07-sla-sweep.md), [Video implementation](../stream/05-video-implementation.md)

## Context

Before this change a host had two ways to take an attendee out of a webinar or class, and neither was a conduct removal.

- The roster's **Remove** (`DELETE /api/participants/{webinar|class}/[id]?userId=`, `leaveEventSeat` in `lib/booking/seat-leave.ts`) is a no-fault removal: it ends the seat and refunds it in full at once. Only the plan owner, an organisation operator and staff may use it; a co-host may not.
- The Stream SDK's **Kick** and **Block** in a live call reach the plan owner through the `-owner` grants that the `call_member` and `user` roles hold on the `default` call type. They leave no Postgres record, no reason and no review, and the seat and its money stay as they were.

A disruptive attendee therefore either kept their seat and their access, or was refunded in full by the host they disrupted.

## Decisions

1. **One transaction at removal, with `tx` passed everywhere, and no refund.** `removeAttendeeForConduct` (`lib/booking/conduct-removal.ts`) runs under the event's appointment lock in one Serializable transaction:
   - the seat ends: `releaseParticipant` moves it to `CANCELLED` by compare-and-set on its live statuses, so a repeat finds nothing and returns `removed: false`;
   - a `CONDUCT_REMOVAL` support case opens for the attendee (`openConductRemovalCaseTx` in `lib/support/conduct-removal-case.ts`). It records the removal itself: the attendee is the requester and the submitter, the `CREATED` event's actor is the remover, the description and first message carry the reason and note, and the case's creation time is when;
   - the seat's unpaid earnings are held for the case (`holdSeatEarningsTx`, through `holdPaymentForCase`, a `SUPPORT_CASE` hold with a `HOLD_APPLIED` event). A payout already being sent cannot be held; the case still opens and an internal message says why;
   - the Stream intents are written in the same transaction: `persistSeatRevocationInTx` (event channel, host DMs, call membership) and `persistConductBlockInTx` (the call block, kind `CONDUCT_CALL_BLOCK`).

   After the commit, `syncConductCallBlock` and `revokeEndedSeatAccess` drive both intents inside the request's budget and settle only the generation the transaction wrote. An instance that dies after the commit leaves both rows `PENDING`, and `retry-moderation-enforcement` re-drives them through `redriveAccessRevocation`. The old design called Stream first and queued a retry only when the call returned false, so a timeout between the commit and the queue lost the kick.
   - Options not chosen: driving Stream before the commit (a Stream failure would roll back a valid removal); queueing the retry after the Stream call (the old gap).

2. **Stream blocks; it does not only kick.** `driveConductCallBlock` (`lib/stream/conduct-call-block.ts`) reads the removal from Postgres first, then for each of the appointment's rooms whose `Meeting.endedAt` is null calls `call.kickUser({ user_id, block: true })`, which disconnects the attendee and blocks them from rejoining, falling back to `call.blockUser({ user_id })` when Stream answers that the user is not in the call. The event channel removal comes from the seat intent. When the removal is overturned the same intent kind is written again and the same drive calls `call.unblockUser({ user_id })`. The calls match `KickUserRequest`, `BlockUserRequest` and `UnblockUserRequest` in the installed `@stream-io/node-sdk` 0.8.15 typings and the Node samples on Stream's "Kicking & Blocking a member from a call" page.
   - Options not chosen: a kick without a block (the attendee could rejoin a room that still lists them); a separate unblock kind (one kind whose direction comes from Postgres cannot drive the wrong way after a re-arm).

3. **The refund on an overturn or a missed deadline is whatever is still unrefunded on the seat's payment, on the rails it came from.** Both stamp one full-balance refund-owed marker (`amountPaise: null`) keyed `conduct-removal:<caseId>:pay:<paymentId>`, so an overturn after a lapse never refunds twice. After the commit `refundRemovedAttendeeSeat` refunds `mode: "full"`, which is the payment's refundable balance from `refundableBalancePaise` (`REFUNDABLE_BALANCE_SELECT`): a `FAILED` or `CANCELLED` refund does not count, a `PENDING` or `SUCCEEDED` one does. `driveRefundOwed` then replays the marker and clears it; `retry-auto-refunds` re-drives a marker a crash leaves.
   - Worked example: a ₹1,000 class seat with ₹250 already refunded and a ₹100 refund that failed returns ₹750.
   - A free seat (`isPriceFreePayment`) owes nothing and stamps no marker. A credit-funded seat restores its credits through `creditSeatRefund`. When another door's refund already holds the payment's marker, `stampOwedOrHeld` records the hand top-up and holds the earnings, as every other door does.
   - An **upheld** removal refunds nothing automatically; support uses its existing refund doors.
   - Options not chosen: counting refund rows to decide whether the remedy was paid (the old design; a ₹1 partial refund passed as "refunded in full"); a fixed amount from the list price (wrong after a partial refund or a dispute).

4. **The review deadline is 72 hours, enforced by an arm in the existing support SLA sweep.** `DEADLINE_HOURS.CONDUCT_REMOVAL` (`lib/support/deadline-policy.ts`) sets the case's `statutoryDueAt`, so the sweep's existing SLA notices warn staff before it. `sweepConductRemovalDeadlines`, called from `runSupportSlaSweep` (`lib/support/sla-sweep.ts`) with at most 5 cases a run, takes removal cases created 72 hours ago or more that have no decision and no `REMOVAL_REVIEW_LAPSED` event. In one transaction per case it writes that event, stamps the refund of decision 3 and posts a message to the attendee; it then drives the refund. The event makes the arm fire once. The block stays until support decides.
   - Options not chosen: a new job, route or scheduler (`lib/cron/AGENTS.md`); 7 days, the old draft's default.

5. **The Stream SDK's kick and block bypass is closed by the call type contract.** `intendedDefaultCallTypeGrants` (`lib/stream/control-plane-contract.ts`) now strips `kick-user` and `block-user` in every scope (`SERVER_ONLY_CALL_MODERATION`) from the `user` and `call_member` roles of the `default` call type. `co_presenter` never held them. The owner applies it with `scripts/stream/ensure-call-type-grants.ts` after the deploy; the steps are in [Video implementation](../stream/05-video-implementation.md). The only thing that relied on those grants is the SDK participant list's Kick and Block items for the call creator; the server's own `kickUser` calls (`revokeCollaboratorAccess` and the conduct drive) run as the server client, which grants do not limit.

6. **Schema: two enum values, no table.** Every fact a removal needs is already recorded by an existing row, so no `ParticipantRemoval` table is added:

   | Fact                       | Recorded by                                                                            |
   | -------------------------- | -------------------------------------------------------------------------------------- |
   | who was removed, from what | `SupportCase.requesterUserId`, `appointmentId`, the `APPOINTMENT` subject              |
   | who removed them           | the `CREATED` `SupportCaseEvent`'s `actorId`                                           |
   | why                        | the case description and first message (reason label and note)                         |
   | when                       | `SupportCase.createdAt`; the seat's own `CANCELLED` status                             |
   | the outcome                | `SupportCaseDecision` (`UPHELD` or `OVERTURNED`), or the `REMOVAL_REVIEW_LAPSED` event |

   `SupportCase.category` is a free string, so `CONDUCT_REMOVAL` needs no `SupportThreadCategory` value. Two values earn their place: `StreamRevocationKind.CONDUCT_CALL_BLOCK`, because no existing kind blocks or unblocks a call, and `SupportCaseEventKind.REMOVAL_REVIEW_LAPSED`, because no existing row records that the deadline passed, and the arm needs that row to fire once. The owner applies both with the release reconcile push of #2762; `prisma/sql/known-drift.json` lists the two statements.
   - Options not chosen: a `ParticipantRemoval` table with its own status enum (a second copy of the case's facts and outcome); a `SupportThreadCategory` value (the case column is not that enum).

7. **The attendee is told.** After the commit the removal sends the existing removed-seat notice (`notifyFreeSeatRemoved` in `lib/booking/seat-removed-notice.ts`, a bell and an email), and the case intake bell reaches them as an agent message. The case copy says the host "removed you", never "cancelled". Once the required-notice change lands, that notice becomes a required `SEAT_RELEASED` notice and reads as a removal.

8. **Who may remove.** The plan owner and an accepted presenter-tier co-host (`CO_HOST`, `CO_INSTRUCTOR`), as the owner decided, plus the people who may already remove attendees on the roster: an active organisation operator with `catalog.manage` or `appointments.actForOrg.cancel`, and staff (`canRemoveForConduct` in `lib/api/participants/group-participants-route.ts`). Crew collaborators and attendees may not. Three doors share that rule and the one transaction: `POST /api/participants/{webinar|class}/[id]/remove` (the roster and the event chat) and `POST /api/meetings/[meetingId]/remove` (the live room's People tab).

Support decides a removal case as an appeal is decided: `UPHELD` or `OVERTURNED` (`assertDecisionFitsCase` in `lib/support/case-actions.ts`; the staff panel offers those two through `reviewsRemoval`). An appeal of that decision decided `OVERTURNED` overturns the removal too. An overturned removal cannot be superseded back to upheld, because its refund and unblock are already owed. A removal case is a sensitive personal category (`ORG_SENSITIVE_PERSONAL_CATEGORIES`), so the host, a presenter and organisation views never read the attendee's side.

Tests: `__tests__/db/booking/conduct-removal.db.test.ts` (the one transaction and its rollback, the crash and the redrive, the ₹750 overturn, the unblock, the free and credit seats, the 72-hour arm firing once), `__tests__/booking/conduct-removal-route.test.ts` (who may remove), `__tests__/events/conduct-removal-dialog.test.tsx` (what the in-room control sends, parsed by the route's schema).

## Limits that remain

- A `PENDING` refund counts against the balance when the overturn or the lapse is driven. If that refund fails later, its own door restores what it owed (`restoreOwedOnFailedRefund` for a support hand refund, the marker's attempt count for a marker drive); the conduct removal does not refund it again.
- A room that Postgres has stamped ended but Stream has not is not blocked; the seat revocation still removes the attendee from its members.

## Deprecated & Superseded Approaches

- **Kick first, queue the retry on failure** (the first draft of this feature): the retry row was written only after Stream answered, so a crash in between lost it. Superseded by intents written in the removal's transaction.
- **Counting refund rows as the deadline remedy** (the first draft): superseded by the refundable balance and one keyed full-balance marker.
