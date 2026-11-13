# ADR: Event chat and call membership follows seats that hold access, never payments

- **Status**: Accepted (2026-11-14). It restores a rule already decided: a seat that ended has no chat or call access ([the group-room fulfilled entitlement](2026-11-02-group-room-fulfilled-entitlement.md)). Built on the branch that carries this record.
- **Date**: 2026-11-14
- **Author**: Platform engineering
- **Related**: [Channel management](../stream/06-channel-management.md#participant-sources), [Channel lifecycle](../stream/17-channel-lifecycle.md), [The bug hunt in support and Stream](2026-11-12-bug-hunt-support-and-stream.md)

## Context

Preview QA found that a learner who left a free webinar was put back into its chat by the next registration. Hannah created a free webinar. Charlotte registered and then left: her seat became `CANCELLED`, her seat revocation intent (`SEAT_ACCESS_REVOKE`) was driven and settled, and the channel `team:webinar-<id>` held only Hannah. Daniel then registered, and about nine seconds later the channel held Hannah, Charlotte and Daniel. Charlotte's seat was still `CANCELLED`.

The cause was the registration-time sync, `ensureChannelsForAppointment` in `lib/payments/webhooks/ensure-channels.ts`. Both registration paths run it after their commit: the zero-amount, mock and organisation-funded checkout in `lib/payments/checkout/orchestrate.ts`, and the capture webhook in `handlePaymentSuccess` (`lib/payments/webhooks/handlers.ts`). The `reconcile-orphaned-confirmations` job runs it too, for any appointment whose `chatChannelEnsuredAt` is still empty. It took its buyer list from every `SUCCEEDED`, undeleted `Payment` on the appointment. A payment outlives the seat it bought. `PaymentStatus` has no refunded state, because refunds are separate `Refund` rows. So every buyer whose seat had ended was still on that list. For each one, `addUserToEventChannel` added them back to the existing channel, `createDirectMessageChannel` re-created their DM with the host, and `addSeatHoldersToOpenCalls` added them back to every call already provisioned.

What this undid, before the fix:

- a self-leave, free or paid;
- an organiser's removal;
- a refund that ended the seat;
- a captured payment parked for an auto-refund (a `HELD` seat with `refundOwedKey` set).

What it did not undo:

- an erasure, because `scrubUser` withdraws the Stream consent and the upsert then refuses the account (`account_refused`);
- a permanent moderation ban, because Stream deactivates the user;
- an unpaid hold that lapsed, because its payment is never `SUCCEEDED`.

A time-limited suspension does not end a seat, so there is nothing for this sync to undo. The revocation intent had already been settled before the re-add, so nothing re-drove it. When a call already existed, the `fenceSeatGrants` check inside `addSeatHoldersToOpenCalls` saw the ended seat, wrote a new intent and removed the person again. That removal took them out of the channel and the DMs too. The QA webinar had no call yet, so the re-add stayed.

## Decision

1. **One definition of who is an event member.** The members of a `webinar-<id>` or `class-<id>` channel, and the client members of its calls, are:
   - the plan owner;
   - each `ACCEPTED` collaborator whose profile is not deleted;
   - each `CONSULTEE` seat that matches `paidParticipant()` in `lib/booking/participants.ts`.

   `paidParticipant()` is the fulfilled entitlement the meeting gate already admits. It matches a `CONFIRMED` or `ATTENDED` seat whose payment is `SUCCEEDED` or which has no payment. It also matches a `HELD` seat whose `SUCCEEDED` capture owes no refund, has no pending or succeeded refund, and carries no settled-elsewhere marker. A `CANCELLED` or `REFUNDED` seat never matches.

2. **Every path that sets or extends those members reads that definition.**
   - `ensureChannelsForAppointment` builds its group-event list from the appointment's `participants` filtered by `role: "CONSULTEE"` and `paidParticipant()`. That list feeds the channel adds, the host DMs and `addSeatHoldersToOpenCalls`.
   - `getEventData` in `lib/stream/event-channel-service.ts` already used the definition. It is the roster for a channel created on the first join.
   - `loadEventChannelData` in `actions/stream/chat/channel.action.ts` builds the roster for `POST /api/stream/channels/create`. It now uses `paidParticipant()` in place of `liveParticipant()`, so an unpaid hold no longer gets chat.
   - Every other member writer already checked the same rule: the open route (`isEventParticipant`), `/join` (`resolveMeetingAccess`), collaborator accept (it adds only the collaborator), and call provisioning, which creates group rooms with hosts only.
   - The 1:1 branch still lists buyers from payments. `createDirectMessageChannel` refuses any pair that `canDirectMessage` does not allow, so a cancelled or refunded 1:1 does not reopen its DM.
3. **Enforced by** the shared predicate and `__tests__/stream/event-membership-follows-seats.test.ts`. The test covers a webinar and a class, each with a free and a paid registration, and pins who reaches the mocked Stream client: the remaining seats and the newcomer reach chat, the DMs and the call; the host and collaborators are added when the channel is created; a learner who left, one removed by the organiser, a refunded seat, a lapsed hold and an auto-refunded capture never do.

## Options not chosen

- **Adding only the newly confirmed buyer on a registration.** `chatChannelEnsuredAt` is one stamp per appointment. If one registration stamped after ensuring only its own buyer, an earlier buyer whose join failed would never be retried. The full list of live seats keeps that retry.
- **Making the sync also remove members who no longer hold access.** That would add a second revoker beside the intent machinery and the daily reconciler, with its own budget and failure handling. The sync now never adds such a member, and removal stays with the revocation drive.
- **Re-driving the revocation from the sync for each ended seat it finds.** This was recommended in QA. It is not needed once the sync stops adding those people.
- **A new nightly reconciler.** `reconcile-stream-memberships` already exists.

## Limits that remain

- **People re-added before this fix stay members until something removes them.** Postgres cannot see Stream's membership, so the read below lists candidates. Check each one with Stream's `queryMembers` on the channel.

  ```sql
  SELECT a.id AS appointment_id,
         CASE WHEN a."webinarId" IS NOT NULL THEN 'team:webinar-' || a."webinarId"
              ELSE 'team:class-' || a."classId" END AS channel_cid,
         COALESCE(w.status::text, c.status::text) AS event_status,
         p."userId", p.status::text AS seat_status, p."updatedAt" AS seat_ended_at
  FROM "AppointmentParticipant" p
  JOIN "Appointment" a ON a.id = p."appointmentId"
  LEFT JOIN "Webinar" w ON w.id = a."webinarId"
  LEFT JOIN "Class" c ON c.id = a."classId"
  WHERE p.role = 'CONSULTEE'
    AND p.status IN ('CANCELLED', 'REFUNDED')
    AND (a."webinarId" IS NOT NULL OR a."classId" IS NOT NULL)
    AND EXISTS (SELECT 1 FROM "Payment" own WHERE own."appointmentId" = a.id
                AND own."userId" = p."userId" AND own."paymentStatus" = 'SUCCEEDED'
                AND own."deletedAt" IS NULL)
    AND EXISTS (SELECT 1 FROM "Payment" later WHERE later."appointmentId" = a.id
                AND later."userId" <> p."userId" AND later."paymentStatus" = 'SUCCEEDED'
                AND later."deletedAt" IS NULL AND later."updatedAt" > p."updatedAt")
  ORDER BY p."updatedAt" DESC;
  ```

- **What already removes them.**
  - A `SEAT_ACCESS_REVOKE` intent written again for the person, through `persistSeatRevocation(appointmentId, [userId])` for the sweep or `revokeEndedSeatAccess` to drive it at once, removes them from the channel, the host DMs and the rooms. `driveSeatRevocation` re-reads the seat, and `admittedSeatHolders` no longer admits it. The partial unique index allows a new open row after a settled one. Writing that row is a database write, so the owner decides it.
  - The daily `reconcile-stream-memberships` job removes them from an open, in-retention event channel without any intent. It skips a channel when more than half of its human members would go (its brake), and it skips a cancelled or expired event, whose channel the lifecycle jobs own. The production job fleet is paused before launch, so it does not run there today.

## Consequences

- A registration can no longer reverse a leave, a removal or a refund in chat or in the call.
- An unpaid hold no longer gets a seat in the channel through the create route.
- A webinar or class appointment with no seat holding access returns `no_seat_holding_access` and leaves `chatChannelEnsuredAt` empty. A 1:1 appointment with no `SUCCEEDED` payment still returns `no_succeeded_payment`.

## Deprecated & Superseded Approaches

- **Group-event rosters built from `SUCCEEDED` payments** in `ensureChannelsForAppointment`. Superseded by seats that match `paidParticipant()`.
- **`liveParticipant()` as the event channel roster** in `loadEventChannelData`. Superseded by `paidParticipant()`, the definition every other event member writer already used.
