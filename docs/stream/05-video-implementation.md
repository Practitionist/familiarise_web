# 05. Video Implementation & Session Lifecycle Algorithms

> Authoritative specification of Stream Video room provisioning, the unified `[startsAt - 15m, roomEndsAt + 30m]` envelope, timezone-safe civil day arithmetic, synchronous CAS termination & pre-start rotation, host room reopen with asymmetric webhook routing, the immutable booked end with `+15m` extension state on `Meeting`, the end-reason decision table, exit UX, lobby gate retries, and hybrid Q&A / emoji reactions.

## Table of Contents

- [Meeting Room Architecture & Call Ownership](#meeting-room-architecture--call-ownership)
- [Algorithm 1: Unified Session Window Envelope & Timezone Normalization](#algorithm-1-unified-session-window-envelope--timezone-normalization)
- [Algorithm 2: Synchronous Termination & Pre-Start Device-Check Rotation](#algorithm-2-synchronous-termination--pre-start-device-check-rotation)
- [Algorithm 3: Host Room Reopen & Asymmetric Webhook Lookup](#algorithm-3-host-room-reopen--asymmetric-webhook-lookup)
- [Algorithm 4: `+15m` Room Extension on `Meeting` & Derived Cap Math](#algorithm-4-15m-room-extension-on-meeting--derived-cap-math)
- [Algorithm 5: Unified Call Exit UX (`CallExitButton`) & Lobby Gate Backoff (`MeetingLobbyGateCard`)](#algorithm-5-unified-call-exit-ux-callexitbutton--lobby-gate-backoff-meetinglobbygatecard)
- [Algorithm 6: Hybrid In-Room Chat, Persistent Q&A, Stage Spotlight & Reactions](#algorithm-6-hybrid-in-room-chat-persistent-qa-stage-spotlight--reactions)
- [End Reasons: The Decision Table](#end-reasons-the-decision-table)
- [Deprecated & Superseded Approaches](#deprecated--superseded-approaches)

---

## Meeting Room Architecture & Call Ownership

Every video call executes on Stream Video's hardened `default` call type (`STREAM_CALL_TYPE = "default"`) and obeys strict `1 AppointmentOccurrence = 1 active Stream Call ID` isolation ([ADR-01](./18-architecture-decision-records.md#adr-01-strict-per-occurrence-stream-call-isolation-1-occurrence--1-active-call-id-vs-permanent-link-reuse)):

- **Server-Only Provisioning (`actions/stream/meetings/meeting.action.ts`)**: `provisionAppointmentMeeting` verifies caller entitlement (`readSlotForCaller`), evaluates booking/occurrence health, and calls `call.getOrCreate(...)` using `STREAM_API_SECRET` with:
  - `created_by_id`: plan owner / assigned consultant (granting creator `-owner` permission variants).
  - `members`: every DPDP-consented participant mapped to `call_member`, and `ACCEPTED` presenter collaborators (`CO_HOST`, `CO_INSTRUCTOR`) mapped to `co_presenter`.
  - `settings_override`: `buildCallSettingsOverride(appointmentType, maxDurationSeconds)` (`session.inactivity_timeout_seconds = 300`, `limits.max_duration_seconds = clamp(bookedDuration + 45m, 45m, 12h)` counted from the room end, and Backstage + muted defaults on `WEBINAR` / `CLASS`).
  - `custom`: the organisation and host fields plus the room-time fields (`roomTimeCustom`: `sessionEndsAt`, `sessionBaseEndsAt`, `extendedSeconds`, `extensionsUsed`) that the in-room clock and overrun banner read.
  - The payload is built once by `buildRoomCallPlan` (`lib/meetings/call-provisioning.ts`), and the host reopen route uses the same function, so a reopened room is identical to a freshly provisioned one. The provisioner refuses to create a room for an ended meeting whose end reason is not rejoinable (`endBlocksRejoin`).
- **Bare Call Identifier Storage (`lib/stream/call-cid.ts`)**: `Meeting.streamCallId` always persists the bare call ID (`occurrence-<uuid>` initially, or `occurrence-<uuid>-r<base36>` after rotation). `toCallId(cidOrId)` strips any `"default:"` prefix idempotently, while `parseOccurrenceIdFromCallId(cidOrId)` extracts `<uuid>` across both initial and rotated call aliases.

```mermaid
flowchart LR
    Occ["AppointmentOccurrence (1 scheduled session)"] -->|"1:1 unique FK"| Mtg["Meeting Row (bare streamCallId)"]
    Mtg -->|"Initial room"| Seg0["Stream Call: occurrence-uuid"]
    Mtg -->|"Rotated on pre-start test or reopen"| SegR["Stream Call: occurrence-uuid-rBase36"]
    Bookmark["Stale Email / Bookmark Link"] -->|"parseOccurrenceIdFromCallId"| Mtg
```

---

## Algorithm 1: Unified Session Window Envelope & Timezone Normalization

### 1. Symmetric Envelope Across All 5 Appointment Types

Every appointment type — **`CONSULTATION`**, **`TRIAL`**, **`SUBSCRIPTION`**, **`WEBINAR`**, and **`CLASS`** — enforces the exact same join, live, overrun, and reopen window bounds (`lib/appointments/occurrences.ts`, `lib/meetings/access.ts`, `lib/meetings/duration-cap.ts`):

$$\text{Active Session Envelope} = [\,\text{startsAt} - 15\text{m},\; \text{roomEndsAt} + 30\text{m}\,]$$

The room end is `AppointmentOccurrence.endsAt + Meeting.extendedSeconds` (`resolveRoomEndsAt` in `lib/meetings/duration-cap.ts`). The booked `endsAt` itself is never moved by an extension.

| Parameter                                  | Constant / Source                                        | Value                         | Behavioral Rule                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Early Join Window (`T - 15m`)**          | `CONSULTEE_JOIN_WINDOW_MS` / `CONSULTANT_JOIN_WINDOW_MS` | `900_000 ms` (15m)            | symmetric for both hosts and participants; prior requests receive HTTP `403` (`code: "TOO_EARLY"`).                    |
| **Room End (`roomEndsAt`)**                | `endsAt + Meeting.extendedSeconds`                       | Booked end or `+15m`          | `extendedSeconds` grows by 900 when a host triggers `POST /api/meetings/[meetingId]/extend`; `endsAt` does not move.   |
| **Rejoin & Overrun Grace (`T + 30m`)**     | `REJOIN_GRACE_MS` / `CALL_DURATION_GRACE_MS`             | `1_800_000 ms` (30m)          | Keeps dashboard `Join` buttons active, permits WebRTC reconnection after Wi-Fi drops, and bounds host room reopens.    |
| **SFU Hard Wall (`max_duration_seconds`)** | `resolveRoomCapSeconds`                                  | `clamp(room + 45m, 45m, 12h)` | Enforced server-side by Stream SFU (`75m` for a 30m `TRIAL`, `105m` for a 60m `CONSULTATION`, `+900s` on host extend). |

The same room end is used by the join gate and the `canReopen` window (`meetingPolicyRefusal`, `resolveMeetingAccess` in `lib/meetings/access.ts`), the reopen route, the outcome sweep's live-overrun deferral, and the orphan reconciler. The booked end remains the reference for the outcome classifier, reminders, money, and recording retention. The dashboard and calendar join buttons keep the booked end because their 30-minute grace already covers a 15-minute extension.

```mermaid
stateDiagram-v2
    [*] --> Upcoming: "Booking confirmed"
    Upcoming --> EarlyLobby: "now < startsAt - 15m (403 TOO_EARLY countdown)"
    EarlyLobby --> JoinableWindow: "now >= startsAt - 15m"
    JoinableWindow --> PreStartDeviceTest: "Host ends before startsAt"
    PreStartDeviceTest --> JoinableWindow: "ended_early -> auto-rotates occurrence-id-rBase36"
    JoinableWindow --> LiveRoom: "Participants join Stream SFU"
    LiveRoom --> ExtendedLiveRoom: "Host extends +15m (Meeting.extendedSeconds + Stream mirror)"
    LiveRoom --> DeliberatelyClosed: "Host clicks End for everyone (now >= startsAt)"
    ExtendedLiveRoom --> DeliberatelyClosed: "Host ends call or SFU max_duration_seconds expires"
    DeliberatelyClosed --> LiveRoom: "Host reopens within roomEndsAt + 30m (rotates streamCallId)"
    DeliberatelyClosed --> Concluded: "now > roomEndsAt + 30m"
    Concluded --> [*]
```

### 2. Viewer Timezone Normalization & DST-Safe Civil Day Arithmetic

Server processes execute in UTC while consultants and consultees span arbitrary IANA zones (`Asia/Kolkata`, `America/Los_Angeles`, `Europe/London`, etc.). Two strict date formatting invariants govern all dashboard badges (`getAppointmentStatus`, `deriveBookingPresentation`, `HomeTab`, `ConsultantAppointmentsAdapter`, `MeetingLobbyGateCard`):

1. **Viewer Zone Formatting (`formatInViewerZone`)**: Every rendered timestamp and relative day label formats against explicit `viewerZone` (`session.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone`), never bare `new Date().toLocaleTimeString()` or server-local `getFullYear()` / `getDate()`.
2. **Civil Day-Number Subtraction Without `now + 86_400_000`**: Adding `86_400_000` milliseconds (`24h`) to `now` skips or duplicates calendar days across 23-hour spring-forward and 25-hour fall-back DST transitions. Relative day buckets compute exact integer day deltas from timezone-formatted `"yyyy-MM-dd"` civil keys:
   ```typescript
   const dayNumber = (key: string): number => {
     const [year, month, day] = key.split("-").map(Number);
     return Date.UTC(year, month - 1, day) / 86_400_000;
   };
   const targetDayKey = formatInViewerZone(effectiveTime, zone, "yyyy-MM-dd");
   const todayKey = formatInViewerZone(now, zone, "yyyy-MM-dd");
   const diffDays = dayNumber(targetDayKey) - dayNumber(todayKey);
   // diffDays === 0 -> "Today" | diffDays === 1 -> "Tomorrow" | diffDays < 7 -> "In N days"
   ```

---

## Algorithm 2: Synchronous Termination & Pre-Start Device-Check Rotation

When a host selects **End session for everyone**, `POST /api/meetings/[meetingId]/end` (`app/api/meetings/[meetingId]/end/route.ts`) terminates the live Stream SFU room and updates PostgreSQL **synchronously** so returning to `/dashboard` immediately reflects the post-call state without waiting for Stream's webhook queue:

```mermaid
sequenceDiagram
    participant Host as Host Browser
    participant EndAPI as POST /api/meetings/[id]/end
    participant SFU as Stream Video SFU
    participant DB as PostgreSQL (CAS Transaction)

    Host->>EndAPI: POST /api/meetings/{callId}/end
    EndAPI->>EndAPI: guardMeetingRoute + require role === "host"
    EndAPI->>SFU: withStreamCircuitBreaker(() => call.end())
    EndAPI->>DB: recordMeetingEndedSynchronously(callId, now)
    alt Pre-Start Device Test (now < startsAt)
        DB->>DB: CAS classify endedReason = "ended_early", keep occurrence SCHEDULED
        DB->>DB: Stamp endedAt, rotate streamCallId = "occurrence-uuid-rBase36", next join rebuilds the room
        DB->>DB: Close the old segment's open MeetingPresence (closedByEnd) & MeetingAttendance
    else Live Session End (now >= startsAt)
        DB->>DB: CAS set endedAt = now, endedReason = "call_ended", isRecording = false
        DB->>DB: Close this segment's open MeetingPresence (leftAt = now, closedByEnd) & MeetingAttendance (lastLeftAt = now)
    end
    alt No Meeting matched
        EndAPI-->>Host: HTTP 404 { code: "MEETING_NOT_FOUND" }
    else DB write throws error
        EndAPI-->>Host: HTTP 500 ("Could not end this meeting. Please try again.")
    else DB write succeeds
        EndAPI-->>Host: HTTP 200 { ended: true, callId }
    end
```

### Critical Branch Rules

1. **Pre-Start Device Check (`endedAt < startsAt`)**:
   - A consultant testing audio/camera at `startsAt - 12m` and clicking **End session for everyone** has **not** delivered the scheduled session.
   - `recordMeetingEndedSynchronously` classifies the event as `"ended_early"`, keeps `AppointmentOccurrence.completionStatus = "SCHEDULED"`, and stamps `endedAt` with `endedReason = "ended_early"` and rotates `Meeting.streamCallId` to a fresh `occurrence-<uuid>-r<base36>` id, closing the old segment's open presence and attendance rows in the same transaction. Because `ended_early` is rejoinable, the access gate lets both sides in, and the provisioner (`provisionAppointmentMeeting`) creates a clean call on a new id and clears `endedAt` and `endedReason`. Both consultant and consultee still see an active `Join` button on their dashboards and enter an un-ended room at start time.
2. **Live Session Termination (`endedAt >= startsAt`)**:
   - Atomically stamps `Meeting.endedAt = now`, `Meeting.endedReason = "call_ended"`, `Meeting.isRecording = false` via CAS (`where: { id: meeting.id, endedAt: meeting.endedAt }`), closes the segment's open `MeetingPresence` rows (marked `closedByEnd`, an assumption the outcome sweep checks against Stream's participant sessions) and open `MeetingAttendance` rows, and prevents attendee rejoin unless reopened by the host.
3. **Explicit HTTP `500` Error Propagation**:
   - If `recordMeetingEndedSynchronously` rejects after `call.end()`, the route captures the exception via `reportSentryError` and returns HTTP `500` rather than silently succeeding with HTTP `200`.
4. **Result Shape & Rate Limit**:
   - `recordMeetingEndedSynchronously` returns `{ kind: "not_found" | "already_ended" | "recorded" }`. The route answers `404 MEETING_NOT_FOUND` for `not_found`; for the other two it answers `200 { ended: true, callId }`, where `callId` is the id that now represents the room (the rotated id after a pre-start `ended_early`).
   - It refuses to overwrite a deliberate end already on the row (`recordedEndHolds`), so `already_ended` is returned when a drain or org wind-down got there first. The route runs behind `meetingControlLimiter` (10 per minute per user, shared with extend, reopen and live; stage has its own 60 per minute `meetingStageLimiter`).

---

## Algorithm 3: Host Room Reopen & Asymmetric Webhook Lookup

### 1. Why Reopening Rotates `Meeting.streamCallId`

Once `call.end()` executes on `default:occurrence-<uuid>`, Stream permanently marks that `cid` ended in SFU state. If a host accidentally ends a session at `T + 12m`, reopening cannot reuse `occurrence-<uuid>`. Instead, `POST /api/meetings/[meetingId]/reopen` (`app/api/meetings/[meetingId]/reopen/route.ts`) creates the new call first and rotates the database row second:

1. Applies `meetingControlLimiter` (10 per minute per user), then validates the caller session (`requireApiAuth`), DPDP consent (`hasStreamConsent`), host or co-presenter authorization (`isAuthorizedReopenHost`), non-cancelled booking and occurrence status (`!isDeadOccurrence`), and the window `now <= roomEndsAt + REJOIN_GRACE_MS`. A meeting that is not ended answers `{ reopened: false, streamCallId }` unchanged. An ended meeting must have a host-reopenable end reason (`endAllowsHostReopen`; see the decision table below), otherwise the route answers `409`.
2. Builds the call payload with `buildRoomCallPlan`, the same function the provisioner uses: `settings_override` including the Backstage defaults for webinars and classes, members, organisation and host custom fields, the room-time custom fields, and a cap derived from the room end. The extension budget survives the reopen because it lives on `Meeting`.
3. Mints `nextCallId = "occurrence-${occurrenceId}-r${Date.now().toString(36)}"` and creates that call on Stream with `getOrCreate`, inside `withStreamCircuitBreaker`.
4. Only then rotates the row with an optimistic CAS:
   ```typescript
   await prisma.meeting.updateMany({
     where: {
       id: meeting.id,
       streamCallId: meeting.streamCallId,
       endedAt: meeting.endedAt,
     },
     data: {
       streamCallId: nextCallId,
       endedAt: null,
       endedReason: null,
       isRecording: false,
     },
   });
   ```
5. Returns `{ reopened: true, streamCallId: nextCallId }` so `<MeetingLobbyGateCard />` navigates to `/meetings/${nextCallId}` (`router.replace`). If the CAS count is zero (another request won), the route returns `{ reopened: false, streamCallId }` with the current id and leaves the fresh Stream call unused. If Stream fails, nothing was rotated: an open circuit answers `503` and any other failure answers `500`. Meanwhile, any participant joining via the original email link `/meetings/occurrence-<uuid>` resolves transparently to the current id through `loadMeeting` (`parseOccurrenceIdFromCallId`).

### 2. Asymmetric Webhook Lookup Rule

Rotating `Meeting.streamCallId` from segment 1 (`occurrence-<uuid>`) to segment 2 (`occurrence-<uuid>-r<base36>`) requires **strictly asymmetric webhook resolution** across `lib/stream/session-handlers.ts` and `lib/stream/recording-handlers.ts`:

- **Artifact & Presence Events (`call.recording_ready`, `call.recording_failed`, `call.session_participant_joined`, `call.session_participant_left`)**:
  - Query exact `where: { streamCallId }` first, **then fall back to `where: { appointmentOccurrenceId }`** extracted via `parseOccurrenceIdFromCallId(call_cid)`.
  - **Why**: Composite MP4 transcoding (`recording_ready`) and final participant leave duration events from segment 1 arrive asynchronously **after** segment 2 is already live. Falling back to `appointmentOccurrenceId` guarantees zero orphaned recordings and 100% accurate attendance durations.
- **Termination Events (`call.ended`, `call.session_ended`)**:
  - Match **strictly and exclusively on `where: { streamCallId }`** with **zero fallback to `appointmentOccurrenceId`**.
  - **Why**: A delayed `call.ended` or 5-minute SFU inactivity `call.session_ended` webhook from closed segment 1 carries `call_cid = "default:occurrence-<uuid>"`. Because `Meeting.streamCallId` is now `"occurrence-<uuid>-r<base36>"`, strict equality misses cleanly (`null`) and drops the stale termination event without closing the live reopened room.

---

## Algorithm 4: `+15m` Room Extension on `Meeting` & Derived Cap Math

A host can extend a live room by **15 minutes (`900s`) for free**, once per `Meeting`, via `POST /api/meetings/[meetingId]/extend` (`app/api/meetings/[meetingId]/extend/route.ts`). The booked end `AppointmentOccurrence.endsAt` never moves; the extension is stored in `Meeting.extendedSeconds` and `Meeting.extensionsUsed`, and Stream is a derived mirror ([ADR-04](./18-architecture-decision-records.md#adr-04-immutable-booked-end-extension-state-on-meeting)).

1. **Guards.** The route runs behind `meetingControlLimiter` and answers `403` to anyone but the host. It answers `409 SESSION_NOT_EXTENDABLE` when the meeting has ended, the occurrence is deleted, is not `SCHEDULED`, or already has an outcome.
2. **Retry path.** If `extensionsUsed` already equals `MAX_MEETING_EXTENSIONS` (1), the route re-mirrors to Stream (idempotent). It answers `200` when Stream was behind and `409` with `alreadyExtended: true` when it was already in sync.
3. **Multi-party schedule conflict guard (`hasExtensionScheduleConflict`).** Otherwise it evaluates `[startsAt, max(roomEndsAt, now) + 15m]` against non-tentative, non-cancelled `AppointmentOccurrence` rows across the host profile and hosted or co-hosted plans (`buildOccupiedAppointmentFilter`, `buildCohostCommitmentFilter`), all `ACCEPTED` presenter collaborators (`assertConsultantAvailableForWindows`), and every active seat holder (`HELD`, `CONFIRMED`, `ATTENDED`). A conflict answers `409` with `hasConflictingNextBooking: true`.
4. **Single CAS claim.** One `prisma.meeting.updateMany` increments both columns. Its `WHERE` requires `endedAt: null`, `extensionsUsed` equal to the value just read and below the maximum, and the occurrence still `SCHEDULED`, with no outcome, and not deleted. A zero count answers `409 alreadyExtended` if the budget is now spent and otherwise `409 SESSION_NOT_EXTENDABLE`.
5. **Stream mirror (`mirrorExtensionToStream`), outside any transaction.** The route reads the call, then writes `max_duration_seconds = max(existing, derived room cap)` and `custom = { ...existing, sessionEndsAt: roomEnd, sessionBaseEndsAt: bookedEnd, extendedSeconds, extensionsUsed }`. Every value is derived from Postgres, never added to what Stream holds, so a retry converges instead of adding time twice. A Stream failure answers `503 EXTEND_SYNC_PENDING`: Postgres keeps the extension and the host retries.
6. **Banner math (`resolveCapEndsAtMs` in `OverrunBanner.tsx`).** The banner reads `sessionEndsAt` (room end) and `sessionBaseEndsAt` (booked end) from the call `custom`, offers the extension from five minutes before the booked end, and moves through `hidden`, `ending-soon`, `overrun-grace` and `cap-imminent`.

Worked example. Hannah hosts Priya's 10:00-11:00 IST consultation. At 10:56 IST she extends: `extendedSeconds = 900`, `extensionsUsed = 1`, the room end becomes 11:15 IST, and the Stream cap grows from 105 minutes to 120 minutes. The booked end stays 11:00 IST, so if both leave at 11:00 IST the classifier sees a full session. If Hannah ends the call and reopens the room at 11:05 IST, the new Stream call is created with the same 11:15 IST room end and `extensionsUsed = 1`, so she cannot extend a second time.

Residual risk: the database overlap guard `occurrence_no_confirmed_overlap` sees only booked ends. The extension is protected only by the conflict check in step 3 (see the ADR-04 lead-time finding).

---

## Algorithm 5: Unified Call Exit UX (`CallExitButton`) & Lobby Gate Backoff (`MeetingLobbyGateCard`)

### 1. Single Primary Red Exit Control (`CallExitButton` in `EndCallButton.tsx`)

To prevent hosts from accidentally ending a live cohort when stepping out (`ADR-05`), `MeetingRoom.tsx` mounts a single red exit button:

- **Attendees (`!isHost`)**: Clicking the button immediately triggers `onLeaveForSelf()` (`leaveCallAndReleaseMedia(call)` + redirect to role dashboard), keeping the room alive.
- **Hosts (`isHost`)**: Clicking the button opens a 2-action popover menu:
  - **Inline Caution Alert (`remainingMinutes > 10`)**: Whenever more than `10 minutes` (`EARLY_END_WARNING_THRESHOLD_MS`) remain in `info.endsAt`, displays an amber warning card: `"{N} min remaining in this booked slot. Ending for everyone disconnects all participants."`
  - **Action 1 — `Leave call`**: Disconnects only the host's local media session while keeping the room live for participants and co-presenters.
  - **Action 2 — `End session for everyone`**: Calls `POST /api/meetings/[meetingId]/end` (`AbortSignal.timeout(10_000)`), releases local camera/mic hardware tracks, and routes to the dashboard.

### 2. Lobby Gate Countdown & Clock-Skew Retry Backoff (`MeetingLobbyGateCard.tsx`)

When `POST /api/meetings/[meetingId]/join` denies entry with HTTP `403`, `MeetingLobbyGateCard` handles three structured modes:

- **`TOO_EARLY` Auto-Entry with Clock-Skew Protection**:
  - Displays scheduled start time formatted in the viewer's timezone (`formatScheduledAt(startsAt, session.user.timezone)`) and a live `MM:SS` countdown to `openAtMs = startsAt - 15m`.
  - Guards against client/server clock skew (e.g., browser clock ahead of server clock by 2–8s causing `now >= openAtMs` while server still returns `TOO_EARLY`) via a module-level retry map (`autoRetryAttemptsByWindow`) capped at **`MAX_AUTO_RETRIES = 3`** with linear backoff **`AUTO_RETRY_BACKOFF_MS = 5_000`**:
    ```typescript
    const retryAtMs = openAtMs + priorAttempts * AUTO_RETRY_BACKOFF_MS;
    ```
  - After 3 attempts (`T+0s`, `T+5s`, `T+10s`), automatic polling halts cleanly while preserving manual **Check Again** click access.
- **`SESSION_ENDED` with Host Reopen Safety Valve**: Renders **Reopen Session Room** whenever `access.canReopen === true`.
- **`CONSENT_REQUIRED` / Default Denial**: Surfaces DPDP data-processing consent or security access guidance.

---

## Algorithm 6: Hybrid In-Room Chat, Persistent Q&A, Stage Spotlight & Reactions

Live interaction inside `MeetingRoom.tsx` combines ephemeral WebRTC media events with server-verified Q&A persistence (`app/api/meetings/[meetingId]/qa/route.ts`, `lib/meetings/stage-qa.ts`, `StageQaDrawer.tsx`, `StagePinnedBannerOverlay.tsx`):

1. **In-Call Chat & Q&A Modality Gate (`isInCallChatAllowed`)**:
   - Enabled for `CONSULTATION`, `SUBSCRIPTION`, `WEBINAR`, and `CLASS`.
   - Completely blocked for free `TRIAL` sessions (`403 trial_chat_disabled` on API + `data-in-call-chat-blocked="true"` on client) to block pre-purchase off-platform leakage.
2. **Server-Verified Questions, Upvoting & Host Answers / Stage Spotlight**:
   - Submitting a question (`POST /api/meetings/[meetingId]/qa`) authenticates caller session and role via `guardMeetingRoute`, stamps verified server author identity (`id: "qa_<uuid>"`, `authorName`, `authorRole`), persists question metadata (`stageQuestionRedisKey`, 6h TTL), supports attendee upvoting and host answer tracking, and broadcasts `familiarise.qa.question` over Stream WebSockets (`call.sendCallEvent`).
   - Clicking **Show on screen** (`action: "pin"`, restricted strictly to `access.role === "host"`) writes `custom.activeStageBanner` onto the Stream call document (preserving existing `custom.organizationId` / `custom.extendedSeconds`) **and** emits `familiarise.qa.pin` over WebSockets so both live and late-joining attendees see the lower-third `<StagePinnedBannerOverlay />`.
3. **Ephemeral Emoji Reactions (`ReactionsButton`)**:
   - Rendered natively via Stream Video SDK's `<ReactionsButton />` in the bottom control bar, backed by `create-call-reaction` role grants on `call_member` and `co_presenter`.

---

## End Reasons: The Decision Table

`Meeting.endedReason` stays a string column but holds only the values in `MEETING_END_REASONS` (`lib/meetings/end-reasons.ts`). A Zod enum (`meetingEndReasonSchema`) validates them in the application, and the sidecar CHECK `meeting_ended_reason_known` (`prisma/sql/check-constraints.sql`, added `NOT VALID` and then validated) admits only the same vocabulary in Postgres. The table `END_REASON_POLICY` answers four questions for each reason:

| Reason                  | deliberate | rejoinable | hostReopenable | money      | Written by                                                             |
| ----------------------- | ---------- | ---------- | -------------- | ---------- | ---------------------------------------------------------------------- |
| `call_ended`            | yes        | no         | yes            | `host_end` | the synchronous end route; `handleCallEnded` for a person or no reason |
| `maintenance`           | yes        | no         | yes            | `outage`   | the maintenance drain (`actions/maintenance/drain-sessions.ts`)        |
| `org_deactivated`       | yes        | no         | no             | `none`     | the org wind-down job (`jobs/stream/wind-down-deactivated-orgs.ts`)    |
| `org_deleted`           | yes        | no         | no             | `none`     | org hard delete (`app/api/organizations/[orgId]/route.ts`)             |
| `session_timeout`       | no         | yes        | no             | `none`     | `handleSessionEnded` (Stream inactivity timeout)                       |
| `ended_early`           | no         | yes        | no             | `none`     | a host's end before the booked start; the room is rotated and reusable |
| `stream_ended`          | no         | no         | yes            | `none`     | `handleCallEnded` for any other Stream reason                          |
| `reconciled`            | no         | no         | no             | `none`     | the orphan reconciler (`lib/meetings/reconcile-orphaned-sessions.ts`)  |
| `reconciled_no_end`     | no         | no         | no             | `none`     | the orphan reconciler                                                  |
| `stream_not_found`      | no         | no         | no             | `none`     | the orphan reconciler                                                  |
| `stream_not_configured` | no         | no         | no             | `none`     | the orphan reconciler                                                  |

How each column is enforced:

- **deliberate**: `isDeliberateEnd` (`lib/appointments/occurrences.ts`) reads this column. `recordMeetingEndedSynchronously`, `handleCallEnded` and `handleSessionEnded` all refuse to overwrite a deliberate end, so a late `call.ended` can no longer turn `maintenance` or `org_deactivated` into `call_ended`. The same writers also keep a sealed end (deliberate no, rejoinable no, such as `stream_ended`) unless the newcomer is deliberate, so a later `call.session_ended` cannot turn `stream_ended` into a rejoinable `session_timeout`; the check is `recordedEndHolds` in `lib/meetings/end-reasons.ts`.
- **rejoinable** (`endBlocksRejoin`): the access gate answers `SESSION_ENDED` to every role for an ended meeting whose reason is not rejoinable, and the provisioner will not create a room for it.
- **hostReopenable** (`endAllowsHostReopen`): the gate offers `canReopen` to a host only when the reason allows it, the occurrence is live, and now is within the room end plus 30 minutes. The reopen route applies the same test. Together with the previous rule, there is no state where participants may join but the room is neither live nor reopenable.
- **money**: the outcome classifier (`classifySessionOutcome` in `lib/booking/session-outcome.ts`) treats `host_end` as a deliberate host end and `outage` as a maintenance outage.

Two fallbacks cover legacy and unexpected rows. An ended row with a NULL reason is read as deliberate and host-reopenable with no money meaning. A stored value outside the vocabulary is read with the `stream_ended` policy.

`mapStreamCallEndedReason` converts a `call.ended` webhook into a reason. An end before the booked start becomes `ended_early`. An end by a user, or with no Stream reason, or with `call_ended` or `end_call`, becomes `call_ended`. Any other Stream reason becomes `stream_ended`, and the raw Stream value is only logged, never stored.

---

## Deprecated & Superseded Approaches

- **Asymmetric Join Windows or Per-Type Grace Divergences**: Superseded by the single unified `[startsAt - 15m, roomEndsAt + 30m]` envelope across all 5 appointment types (`CONSULTATION`, `TRIAL`, `SUBSCRIPTION`, `WEBINAR`, `CLASS`).
- **DST-Unsafe `now.getTime() + 86_400_000` Day Buckets**: Superseded by timezone-explicit `formatInViewerZone` `"yyyy-MM-dd"` civil day-key subtraction (`Date.UTC(year, month - 1, day) / 86_400_000`).
- **Pre-Start Host Hangup Permanently Closing Scheduled Slots**: Superseded by `"ended_early"` detection (`endedAt < startsAt`) + immediate `occurrence-<uuid>-r<base36>` rotation so pre-call device checks keep the session upcoming.
- **Unconditional `appointmentOccurrenceId` Fallback on End Webhooks**: Superseded by asymmetric webhook routing (`ADR-02`), preventing delayed `call.ended` webhooks from closed segments from killing reopened rooms.
- **Extending by Moving `AppointmentOccurrence.endsAt`**: Superseded by `Meeting.extendedSeconds` (ADR-04), because moving the booked end lost the 15 minutes at classification and a Stream-held counter was reset by reopen. Delete any extend-path write to `endsAt`.
- **Freeform `endedReason` Strings and Per-Site Deliberate Sets**: Superseded by `END_REASON_POLICY` and the `meeting_ended_reason_known` CHECK; raw Stream reasons are no longer persisted.
- **Reopen That Rotated the Row Before Creating the Call**: Superseded by Stream-first reopen, so a Stream failure leaves the ended row untouched.
- **Unbounded `TOO_EARLY` Retry Loops on Client Clock Skew**: Superseded by `autoRetryAttemptsByWindow` (`MAX_AUTO_RETRIES = 3`, `5_000ms` linear backoff) in `MeetingLobbyGateCard.tsx`.

---

## Navigation

- [Previous: 04. Chat Implementation](./04-chat-implementation.md)
- [Next: 06. Channel Management](./06-channel-management.md)
- [Architecture Decision Records (ADR-01..ADR-05)](./18-architecture-decision-records.md)
- [Back to Index](./README.md)
