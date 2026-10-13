---
name: stream
description: Work on this repo's Stream.io integration — chat channels, video calls, tokens, webhooks, recordings, replay marketplace, attendance settlement, moderation, DPDP compliance, and the crons around them. Use when the user says "stream", "chat channel", "DM channel", "meeting", "video call", "call type", "stream token", "recording", "replay", "attendance", "no-show", "backstage", "overrun", "webhook not firing", or is touching lib/stream/, lib/stream-*.ts, lib/meetings/, actions/stream/, app/api/stream/, app/api/meetings/, app/meetings/, components/chat/, components/recordings/, or scripts/stream/.
---

# Stream Chat & Video Operational Skill

Two products under one API key: **Stream Chat** (`stream-chat`, `stream-chat-react`) and **Stream Video** (`@stream-io/video-react-sdk`, `@stream-io/node-sdk`). They share a user store, a JWT signing secret, and a token-revocation timestamp (`revoke_tokens_issued_before`) — while billing independently (Chat by MAU, Video by participant-minute).

---

## 1. Live Verification Before Believing Code

Always verify control-plane state and database rows before assuming code changes are active in production. Keep `STREAM_MCP_READ_ONLY: "true"` in `.mcp.json` because dev, preview, and production share one Stream app (`app_id: 1366319`, `placement: "gcp-us-east5.c1"`):

```text
mcp__stream-io__app_get_settings
mcp__stream-io__video_get_call_type   {"name": "default"}
mcp__stream-io__video_query_calls     {"filter_conditions": {"ended_at": {"$exists": false}}}
mcp__stream-io__chat_query_channels   {"filter_conditions": {"type": {"$eq": "messaging"}}}
mcp__stream-io__app_get_rate_limits   {}
```

## 2. Architecture Map (`Where Things Live`)

| Subsystem / Concern                    | Primary Files                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Server Clients, Tokens & Breaker**   | `lib/stream-client.ts`, `lib/stream/token-ttl.ts`, `lib/stream/initial-tokens.ts`, `lib/stream/seed-token-cache.ts`, `actions/stream/chat/stream.action.ts`                                                                          |
| **Client Connection Store (SSR-Safe)** | `providers/StreamProvider.tsx` (SDK-free shell), `providers/StreamProviderImpl.tsx` (lazy SDK chunk, gates prefetch on `!isSessionPending && !!sessionUserId`), `lib/stream/connection-store.ts`, `lib/stream/disconnect.ts`         |
| **Channel IDs, Batch & Call CID**      | `lib/stream-channel-ids.ts`, `lib/stream-utils.ts`, `lib/stream/batch.ts` (`queryChannelsPaged` 30-cap, `createMemberChunk` 100-cap), `lib/stream/call-cid.ts` (`STREAM_CALL_TYPE = "default"`, `parseSlotIdFromCallId`)             |
| **Chat & Event Channel Services**      | `actions/stream/chat/channel.action.ts`, `lib/stream/event-channel-service.ts`, `actions/stream/chat/event-channel.action.ts`, `actions/stream/chat/user.action.ts`, `app/api/stream/channels/open/route.ts`                         |
| **4-Part DM Eligibility & Org Scope**  | `lib/stream/dm-eligibility.ts` (`canDirectMessage`, `pairBookingContexts`), `lib/stream/dm-eligibility-statuses.ts` (`DM_ELIGIBLE_STATUSES`, `OPENABLE_EVENT_STATUSES`), `lib/stream/org-channel-filter.ts`                          |
| **Unified Session Envelope & Access**  | `actions/stream/meetings/meeting.action.ts`, `lib/meetings/{access,route-guard,duration-cap,room-ready,stage-qa}.ts` (`CONSULTEE_JOIN_WINDOW_MS = 15m`, `CONSULTANT_JOIN_WINDOW_MS = 15m`, `REJOIN_GRACE_MS = 30m`)                  |
| **Meetings API Routes**                | `app/api/meetings/[meetingId]/{join,end,reopen,live,extend,qa,recording-consent,stage}/route.ts`                                                                                                                                     |
| **Meeting Room UI & Stage Moderation** | `app/meetings/[id]/components/{MeetingRoom,MeetingSetup,MeetingLobbyGateCard,StageControls,StageQaDrawer,StagePinnedBannerOverlay,OverrunBanner,RecordingControls,EndCallButton,CallEnded}.tsx`, `app/meetings/[id]/session-info.ts` |
| **Webhooks & Attendance Settlement**   | `app/api/stream/webhooks/route.ts`, `lib/stream/{webhook-signature,webhook-receipt,webhook-dispatch,session-handlers,recording-handlers,call-presence}.ts`, `lib/booking/{session-outcome,session-outcome-sweep}.ts`                 |
| **Recordings & R2 Multipart Storage**  | `lib/storage/r2-client.ts`, `lib/stream/{recording-storage,recording-transfer-service,recording-service,recording-consent,recording-retention}.ts`, `app/api/stream/recordings/[recordingId]/{route,publish,preview}/route.ts`       |
| **DPDP Privacy & Control-Plane Crons** | `lib/compliance/erasure/scrub-user.ts`, `scripts/stream/{ensure,ensure-webhook-subscription,stream-sync}.ts`, `jobs/stream/{expire-event-channels,transfer-recordings,expire-recordings,wind-down-deactivated-orgs}.ts`              |
| **Architecture Docs & ADRs**           | `docs/stream/README.md`, `docs/stream/01-architecture.md`, `docs/stream/05-video-implementation.md`, `docs/stream/18-architecture-decision-records.md` (`ADR-01`..`ADR-05`)                                                          |

---

## 3. Server-Action Boundary, Call Isolation & Webhook Security Rules

1. **1 Occurrence = 1 Active Stream Call (`ADR-01`) & Stale-Link Aliasing**:
   - Every `AppointmentOccurrence` maps 1:1 to a `Meeting` row (`appointmentOccurrenceId @unique`). `Meeting.streamCallId` stores bare IDs (`occurrence-<uuid>`, rotating to `occurrence-<uuid>-r<base36>` on pre-start device-test resets or host reopens), never `default:`-prefixed strings.
   - `loadMeeting` (`lib/meetings/access.ts`) looks up `where: { streamCallId }` first and falls back to `parseOccurrenceIdFromCallId(callId)` (`occurrence-<uuid>`) so bookmarks and email calendar links route directly into active rotated call segments.
2. **Never Call Stream RPCs Inside `prisma.$transaction` (`PG_POOL_MAX=1`)**:
   - Execute all Stream network requests outside Prisma transactions wrapped in `withStreamCircuitBreaker`, and guard database transitions via conditional compare-and-set (`updateMany`).
   - Internal Stream modules (`user.action.ts`, `channel.action.ts`, `meeting.action.ts`) never expose unguarded `"use server"` actions; client-callable Server Actions verify `getSession()`, reject banned users, and strip emails (`stripStreamUserEmails`) before Stream writes.
3. **Deterministic IDs Without `localeCompare` & Explicit Token `iat` / `exp`**:
   - Derive channel IDs using UTF-16 code-unit ordering (`a < b ? [a, b] : [b, a]`) capped at 64 chars (`lib/stream-channel-ids.ts`).
   - Always pass both `exp` and `iat` (`Math.floor(Date.now() / 1000) - 60`) when minting tokens so `revoke_tokens_issued_before` cutoffs take effect immediately.
   - `default` call-type grants strip `join-call` from `user`/`guest`, grant `call_member` only `join-call`, `join-ended-call`, `create-call-reaction`, and creator `-owner` moderation grants, and assign accepted presenter collaborators `co_presenter` (mute, pin, backstage, publish; never `end-call`).
4. **Webhook Ingress, Decompression Guard & Subscription Parity**:
   - `/api/stream/webhooks` is exempt from `MAINTENANCE_MODE`, verifies `X-Signature` (HMAC-SHA256 with `STREAM_WEBHOOK_SECRET` + `STREAM_WEBHOOK_SECRET_PREVIOUS` fallback) and `X-Api-Key`, enforces `MAX_WEBHOOK_COMPRESSED_BYTES = 512 KiB` and `MAX_WEBHOOK_DECOMPRESSED_BYTES = 2 MiB`, ignores deliveries outside `[-10m, +2m]` skew without DB bloat, deduplicates on `stream_${X-Webhook-Id}` (`stream_${eventType}_${sha256(rawBody)}` fallback), and enforces exact subscription parity (`DESIRED_EVENT_TYPES`, 8 Video events) via `scripts/stream/ensure-webhook-subscription.ts`.

---

## 4. 4-Part DM & Trial Policy + Contextual Booking Receipt Cards

1. **One Human Pair = One Canonical DM Channel**:
   - **B2C Personal Scope**: `dm-<a>-<b>` (or `dmh-<sha256>` if $> 64$ chars).
   - **B2B Enterprise Org Scope**: `dmo-<orgHash>-<pairHash>` with `custom.organization_id = orgId`.
   - Consultee-to-consultee peer DMs are prohibited (`canDirectMessage` in `lib/stream/dm-eligibility.ts`).
2. **Paid / Confirmed Gate (`DM_ELIGIBLE_STATUSES = ["APPROVED", "SCHEDULED", "COMPLETED"]`)**:
   - Confirmed webinar/class enrollments (`OPENABLE_EVENT_STATUSES`) provision both the group `team` channel (`webinar-<id>` / `class-<id>`) and a 1:1 personal DM with the host, preserving `ACCEPTED` collaborators in `syncUserEventChannels`.
3. **Free Trials (`TRIAL`) Block All Chat Surfaces**:
   - `TrialSession` bookings block all Stream Chat channels, 1:1 DMs, and in-call Q&A/chat (`isInCallChatAllowed("TRIAL") === false`).
4. **Contextual Booking Receipt Cards (`booking-ctx-`)**:
   - `POST /api/stream/channels/open` with `contextAppointmentId` verifies the booking pair and posts an idempotent receipt message (`booking-ctx-${appointmentId}-${eventType}`) into the shared 1:1 DM thread.

---

## 5. Unified Lifecycle Algorithms, Reopen Asymmetry, Attendance & Stage Q&A

1. **Unified Session Window Envelope & Timezone Normalization**:
   - Enforces `[startsAt - 15m, effectiveEndsAt + 30m]` symmetrically across `CONSULTATION`, `TRIAL`, `SUBSCRIPTION`, `WEBINAR`, and `CLASS`, with SFU duration cap `clamp(bookedDuration + 45m, 45m, 12h)` (`resolveMaxCallDurationSeconds`).
   - All relative labels format in `viewerZone` (`formatInViewerZone`) and subtract integer civil day numbers (`Date.UTC(year, month - 1, day) / 86_400_000`) rather than DST-unsafe `now + 86_400_000`.
2. **Synchronous Termination & Pre-Start Device-Check Rotation (`POST /api/meetings/[meetingId]/end` — `ADR-03`)**:
   - Calls `call.end()` on Stream and synchronously invokes `recordMeetingEndedSynchronously` (`lib/stream/session-handlers.ts`) via CAS (`where: { id, endedAt: meeting.endedAt }`).
   - If `endedAt < startsAt` (**pre-start device test**), classifies as `"ended_early"` and immediately rotates `streamCallId = "occurrence-<uuid>-r<base36>"` while leaving the occurrence scheduled (`SCHEDULED`).
   - If `endedAt >= startsAt` (**live end**), stamps `endedReason = "call_ended"`, closes active `MeetingPresence`/`MeetingAttendance` rows, and propagates any unexpected persistence error as **HTTP `500`**.
3. **Host Room Reopen & Asymmetric Webhook Lookup (`POST /api/meetings/[meetingId]/reopen` — `ADR-02`)**:
   - Because `call.end()` permanently seals a Stream `cid`, `/reopen` verifies host/co-presenter/DPDP/booking-status/window guards, rotates `Meeting.streamCallId = "occurrence-<uuid>-r<base36>"` via CAS (`where: { id, endedAt: { not: null } }`), and provisions the fresh Stream call immediately.
   - **Asymmetric Webhook Rule**: `handleRecordingReady`, `handleRecordingFailed`, and `handleSessionParticipantJoined`/`handleSessionParticipantLeft` fall back to `appointmentOccurrenceId` (`parseSlotIdFromCallId`) so pre-reopen recordings and presence are preserved; `handleCallEnded` and `handleSessionEnded` strictly query `where: { streamCallId }` so delayed webhooks from old segments never terminate reopened rooms.
4. **Atomic `+15m` Call Extension & Idempotent Cap Math (`POST /api/meetings/[meetingId]/extend` — `ADR-04`)**:
   - Verifies zero schedule conflicts within `[slotStartsAt, max(slotEndsAt, now) + 15m]` across host, co-presenters, and active participants, stamps `custom.sessionBaseEndsAt` + `custom.sessionEndsAt`, updates `max_duration_seconds`, and advances `AppointmentOccurrence.endsAt` via idempotent CAS (`where: { id: occurrence.id, endsAt: { lt: targetEndsAt } }`). `resolveCapEndsAtMs` (`OverrunBanner.tsx`) anchors to `baseEndsAt ?? endsAt` so live timers never double-add `+15m`.
5. **Single Exit Control (`CallExitButton` — `ADR-05`) & Lobby Backoff (`MeetingLobbyGateCard`)**:
   - Attendees see a single local `Leave call` button; hosts open a 2-choice popover (`Leave call` vs `End session for everyone` with a `< 10m` remaining caution warning).
   - `MeetingLobbyGateCard` handles `TOO_EARLY` countdowns with clock-skew backoff (`MAX_AUTO_RETRIES = 3`, `5_000ms` backoff per window).
6. **Attendance Lock Ordering, Webinar Backfill & Stage Q&A (`StageQaDrawer`, `/api/meetings/[meetingId]/qa`)**:
   - Participant webhooks execute in strict `Meeting -> MeetingPresence -> MeetingAttendance` lock order (`createMany({ skipDuplicates: true })`), clamping out-of-order `firstJoinedAt` monotonically (`firstJoinedAt: { gt: joinedAt }`). Webinar/class end handlers run best-effort `reconcileWebinarAttendance` so missed presence rows are backfilled before settlement.
   - Supports persistent questions (`qa_<uuid>`), upvoting, host answers, lower-third stage banners (`custom.activeStageBanner`), and `<ReactionsButton />`.

---

## 6. Recordings Architecture, DPDP Privacy & Rate-Limit Ceilings

- **Cloudflare R2 Multipart Storage**: `READY` recordings live on `STREAM_S3` (`streamUrlExpiresAt = end + 14d`) until `transfer-recordings` (every 6h) streams SigV4 multipart parts to R2 (`status = AVAILABLE`, `storageType = PLATFORM`) under CAS `TRANSFERRING` claims and SSRF allowlisting (`isAllowedStreamRecordingUrl`). Retention is enforced by daily `expire-recordings` (1:1/sub +90d, webinar/class +365d).
- **DPDP Consent & Right to Erasure (`principal:<userId>`)**: Enforced across `upsertUsersToStream`, `assertCanMintToken`, `resolveMeetingAccess`, and `/reopen`; `scrubUser` invokes `eraseStreamPrincipalFootprint` with durable retry queue (`StreamRevocationRetry`), and `wind-down-deactivated-orgs` terminates active video calls and freezes channels on tenant deactivation.
- **Rate Limits & Pinned SDKs**: Chunk user upserts / roster adds at `100` (`RATE_LIMIT_DELAY_MS = 10_000`), page channel queries at `30` (`queryChannelsPaged`), and keep `stream-chat` on `9.x` (`9.53.0`). Verify control-plane state with `npm exec -- tsx scripts/stream/ensure.ts` and `npm exec -- tsx scripts/stream/ensure-webhook-subscription.ts --apply`.

---

## Deprecated & Superseded Approaches

- **Browser-side call creation (`call.getOrCreate`) and direct `call.endCall()`**: Superseded by server-only `provisionAppointmentMeeting`, `POST /api/meetings/[meetingId]/join`, and `POST /api/meetings/[meetingId]/end` (`end-call` and `join-call` are stripped from default roles).
- **Webhook-only `Meeting.endedAt` writes or HTTP `200` on failed synchronous end**: Superseded by synchronous CAS dual-write (`recordMeetingEndedSynchronously`) returning HTTP `500` on failure and converging monotonically (`supersedesRecordedEnd`) with incoming webhooks.
- **Uniform `where: { streamCallId }` lookup on all webhooks**: Superseded by asymmetric webhook resolution (`ADR-02`) preserving pre-reopen recordings/presence via `parseSlotIdFromCallId` while shielding reopened rooms from late `call.ended` webhooks.
- **Dual red hangup buttons & unbounded lobby auto-retries**: Superseded by unified `<CallExitButton />` (`ADR-05`) and clock-skew-safe `<MeetingLobbyGateCard />` retry backoff (`MAX_AUTO_RETRIES = 3`, `5_000ms`).
- **Legacy per-booking `consultation-*`/`subscription-*` channels**: Superseded by canonical human-pair DM channels (`dm-` / `dmo-`) with `booking-ctx-` receipt cards.
