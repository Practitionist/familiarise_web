---
title: Collaborators — Stream video
type: reference
status: live
last-reviewed: 2026-11-17
---

# Collaborators: Stream video

A collaborator enters a session's live room because they are on the plan's team, not because they hold a seat. This page states what the room gives each role when they join, how a join is re-checked, and what happens to someone removed while a session is running.

## Joining

Two steps decide a join, and both read the `Collaborator` row at the time of the request.

1. **`resolveMeetingAccess`** (`lib/meetings/access.ts`) decides whether the caller may enter and in what capacity. The plan's host gets the `host` meeting role. Otherwise it looks for the caller's `ACCEPTED` row on the session's plan (with a profile that is not deleted): a presenter gets the `host` meeting role marked `coPresenter`, any other collaborator gets the `participant` role marked `speakingCrew` when their role is one of `SPEAKING_CREW_ROLES`. Both carry `collaboratorOf`, the plan the access rests on. A learner is admitted on their seat; the seat lookup spreads `NOT_COLLABORATOR_ROW`, so a booking participant row with the `COLLABORATOR` role admits nobody.
2. **The join route** (`app/api/meetings/[meetingId]/join/route.ts`) writes the call membership and the permissions to Stream, and then runs the fence.

| Who                                                                     | Meeting role  | Stream call role | Permissions written at join on a webinar or class                  |
| ----------------------------------------------------------------------- | ------------- | ---------------- | ------------------------------------------------------------------ |
| Host                                                                    | `host`        | `call_member`    | Granted `send-audio`, `send-video`, `screenshare`.                 |
| Presenter (`CO_HOST`, `CO_INSTRUCTOR`)                                  | `host`        | `co_presenter`   | Granted `send-audio`, `send-video`, `screenshare`.                 |
| Speaking crew (`GUEST_SPEAKER`, `GUEST_LECTURER`, `TEACHING_ASSISTANT`) | `participant` | `call_member`    | `screenshare` revoked, then `send-audio` and `send-video` granted. |
| Support crew (`MODERATOR`, `TECHNICAL_SUPPORT`, `CONTENT_CREATOR`)      | `participant` | `call_member`    | All three publishing permissions revoked, as for a learner.        |
| Learner with a seat                                                     | `participant` | `call_member`    | All three publishing permissions revoked.                          |

Notes on the table:

- **Speaking crew talk from the moment they join.** They do not wait to be brought on stage, and they can share a screen as the host and the presenter can.
- **Support crew join as attendees.** A host can bring one on stage: the stage route (`app/api/meetings/[meetingId]/stage/route.ts`) accepts a member of the plan's current team (`currentTeam`) as its target, although they hold no seat.
- **Presenter controls.** A presenter can record and end the session, as `ROLE_INFO` tells them on the invitation. Taking the room live is the host's alone: the host-live route refuses a caller marked `coPresenter`.
- **The call type's grants are unchanged.** Everything above is a per-user permission write at join, not a change to what the `co_presenter` or `call_member` role may do on the Stream app.
- **A missing custom role does not lock a presenter out.** If Stream rejects `co_presenter` as unknown, the route reports it once and admits the presenter as a plain `call_member`.
- **The join never creates the call.** If the room is not provisioned, the answer is 409 `ROOM_NOT_PROVISIONED`.

### The fence at join

After the Stream writes, the route calls `fenceCollaboratorGrant(access.collaboratorOf, userId)` (`lib/stream/access-revocation.ts`) for anyone admitted as a collaborator:

- The collaboration ended while the join was in flight: the grant is taken back and the answer is 403 `COLLABORATION_ENDED`.
- The row could not be re-read: the answer is 503 `COLLABORATION_UNVERIFIED`, and a revocation is left for the sweep to judge. A collaborator whose row cannot be confirmed is never admitted.
- A Stream write threw part-way: the fence still runs before the error is returned, so a membership that landed is re-checked like any other grant.

Because the row is read on every join, nothing has to be synced into the room when an invitation is accepted. A newly accepted presenter gets the presenter role the first time they join.

## Removal while a session is running

When a collaboration ends, the revocation described in [04 — Stream chat](04-stream-chat-integration.md#revocation) also clears the live rooms. `removeFromOpenRooms` in `lib/stream/collaborator-access.ts` runs beside the chat removal, inside the same time budget.

1. **Which rooms.** `openRooms` selects the plan's sessions that can still be joined: not deleted, on a live event, with a meeting that has not ended and an end time within the longest a call may run.
2. **Someone with no seat on that session** is removed from the call's members, has the publishing permissions revoked, and is kicked from the room (`removeFromRoom`). Their camera, microphone and screen share stop and their client is disconnected.
3. **Someone who also holds a seat on that session** stays in the room as a plain `call_member` with the publishing permissions revoked. They paid for the session and keep watching it as a learner.
4. **Failures are counted, not thrown.** A room that could not be cleared is reported back as "N of M calls not left", the intent stays owed, and the `retry-moderation-enforcement` job tries again.
5. **No write starts after the deadline.** The deadline is checked before each of a room's writes. A room with a write that was not started is reported back as "N of M calls not finished within the time budget"; a write already sent that failed keeps its room under "not left".

From the moment the ending commits, a rejoin is refused by `resolveMeetingAccess`, whatever Stream still holds: the accepted row is gone, and a booking participant row with the `COLLABORATOR` role admits nobody.

### Worked example

A co-host is presenting a webinar that started at 18:00 IST. At 18:20 the host removes them from the Collaborations page.

1. The removal transaction sets the row to `REMOVED`, stamps `endedAt`, and inserts the `COLLAB_REVOKE` intent. It commits.
2. Within the request, the drive finds the webinar's open room. The co-host holds no seat, so they are removed from the call's members, their publishing permissions are revoked and they are kicked. They are also removed from the team chat and the webinar's chat.
3. The intent is marked done. Had Stream been unreachable, the intent would stay owed and the job would clear the room on its next run; meanwhile a rejoin attempt is already refused with 403.
4. A seat on this webinar captured at 18:10 keeps the co-host's share; a seat captured at 18:30 does not include them. See [03 — Revenue sharing](03-revenue-sharing.md).

The room removal is pinned by `__tests__/collaborators/seat-count-and-live-revocation.test.ts` ("revokes live track permissions and kicks unseated collaborator from open SFU rooms").

## Where in code

- `lib/meetings/access.ts`: `resolveMeetingAccess`.
- `app/api/meetings/[meetingId]/join/route.ts`: the membership and permission writes, and the fence.
- `app/api/meetings/[meetingId]/stage/route.ts`: bringing a team member on stage.
- `lib/stream/collaborator-access.ts`: `removeFromOpenRooms`, `removeFromRoom`.
- `lib/collaborators/roles.ts`: `PRESENTER_ROLES`, `SPEAKING_CREW_ROLES`.

## Deprecated & Superseded Approaches

- **Setting the presenter's call role when the invitation is accepted** (`syncOpenCallPresenterRole`). The join route derives it from the row.
- **Admitting a collaborator on a staff participant row.** The gate reads the `Collaborator` row; a participant row with the `COLLABORATOR` role admits nobody.
- **All crew joining with full publishing rights.** Speaking crew publish audio and video; support crew join as attendees.
