---
name: stream
description: Work on this repo's Stream.io integration — chat channels, video calls, tokens, webhooks, recordings, replay marketplace, attendance settlement, moderation, DPDP compliance, and the crons around them. Use when the user says "stream", "chat channel", "DM channel", "meeting", "video call", "call type", "stream token", "recording", "replay", "attendance", "no-show", "backstage", "overrun", "webhook not firing", or is touching lib/stream/, lib/stream-*.ts, lib/meetings/, actions/stream/, app/api/stream/, app/api/meetings/, app/meetings/, components/chat/, components/recordings/, or scripts/stream/.
---

# Stream Chat & Video Operational Skill

Two products under one API key: **Stream Chat** (`stream-chat`, `stream-chat-react`) and **Stream Video** (`@stream-io/video-react-sdk`, `@stream-io/node-sdk`). They share a user store, a JWT signing secret, and a token-revocation timestamp (`revoke_tokens_issued_before`) — but bill separately (Chat by MAU, Video by participant-minute).

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

---

## 2. Architecture Map (`Where Things Live`)

| Subsystem / Concern                     | Primary Files                                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server Clients, Tokens & Breaker**    | `lib/stream-client.ts`, `lib/stream/token-ttl.ts`, `lib/stream/initial-tokens.ts`, `lib/stream/seed-token-cache.ts`, `actions/stream/chat/stream.action.ts`                                                                                    |
| **Client Connection Store (SSR-Safe)**  | `providers/StreamProvider.tsx` (SDK-free shell), `providers/StreamProviderImpl.tsx` (lazy SDK chunk, gates prefetch on `!isSessionPending && !!sessionUserId`), `lib/stream/connection-store.ts`, `lib/stream/disconnect.ts`                   |
| **Channel IDs & Batch Helpers**         | `lib/stream-channel-ids.ts`, `lib/stream-utils.ts`, `lib/stream/batch.ts` (`queryChannelsPaged` 30-cap, `createMemberChunk` / `addRemainingMembers` 100-cap), `lib/stream/call-cid.ts` (`STREAM_CALL_TYPE = "default"`, `parseCallCid`)        |
| **Chat & Event Channel Services**       | `actions/stream/chat/channel.action.ts`, `lib/stream/event-channel-service.ts`, `actions/stream/chat/event-channel.action.ts`, `actions/stream/chat/user.action.ts`, `app/api/stream/channels/open/route.ts`                                   |
| **4-Part DM Eligibility & Org Scope**   | `lib/stream/dm-eligibility.ts` (`canDirectMessage`, `pairBookingContexts`), `lib/stream/dm-eligibility-statuses.ts` (`DM_ELIGIBLE_STATUSES`, `OPENABLE_EVENT_STATUSES`), `lib/stream/org-channel-filter.ts`                                    |
| **Elastic Session Envelope & Meetings** | `actions/stream/meetings/meeting.action.ts`, `lib/meetings/access.ts` (`resolveMeetingAccess`), `lib/meetings/duration-cap.ts`, `lib/meetings/room-ready.ts` (`CONSULTEE_JOIN_WINDOW_MS = 15m`, `REJOIN_GRACE_MS = 30m`)                       |
| **Meetings API Routes**                 | `app/api/meetings/[meetingId]/{join,end,live,extend,recording-consent}/route.ts`                                                                                                                                                               |
| **Meeting Room UI & Stage Moderation**  | `app/meetings/[id]/components/{MeetingRoom,StageControls,OverrunBanner,RecordingControls}.tsx`, `app/meetings/[id]/session-info.ts`                                                                                                            |
| **Webhooks & Attendance Settlement**    | `app/api/stream/webhooks/route.ts`, `lib/stream/{webhook-signature,webhook-receipt,webhook-dispatch,session-handlers,call-presence}.ts`, `lib/booking/{session-outcome,session-outcome-sweep}.ts`, `scripts/earnings/release-earnings.ts`      |
| **Recordings & R2 Multipart Storage**   | `lib/storage/r2-client.ts`, `lib/stream/{recording-storage,recording-transfer-service,recording-service,recording-handlers,recording-consent}.ts`, `app/api/stream/recordings/[recordingId]/{route,transfer,publish,preview}/route.ts`         |
| **Recordings & Replay Marketplace UI**  | `components/recordings/{RecordingPlayerModal,RecordingManageSheet}.tsx`, `app/explore/recordings/[slug]/page.tsx`, `lib/data/recordings-explore.ts`, `app/api/recordings/[recordingId]/purchase/route.ts`                                      |
| **DPDP Privacy & Org Wind-Down**        | `lib/compliance/erasure/scrub-user.ts` (`eraseStreamPrincipalFootprint`), `lib/enterprise/member-removal.ts`, `jobs/stream/wind-down-deactivated-orgs.ts`, `scripts/cleanup/retry-moderation-enforcement.ts`                                   |
| **Control-Plane Provisioning & Sync**   | `scripts/stream/ensure.ts`, `scripts/stream/{ensure-app-settings,ensure-call-type-grants,harden-unused-call-types,ensure-webhook-subscription,stream-sync}.ts`, `jobs/stream/{expire-event-channels,transfer-recordings,expire-recordings}.ts` |

---

## 3. Server-Action Boundary & Security Rules

1. **Server-Action Directive Discipline**:
   - Internal Stream service modules must **not** expose unauthenticated browser-callable RPCs because Stream's server SDK (`STREAM_API_SECRET`) bypasses all Stream permission checks.
   - `user.action.ts`, `channel.action.ts`, and `meeting.action.ts` have NO `"use server"` for unguarded internal primitives (or require `STREAM_SERVER_TRUSTED` / `getSession(true)` actor verification + `stripStreamUserEmails` PII stripping before any Stream write).
   - `actions/stream/chat/event-channel.action.ts` is a thin `"use server"` wrapper over `lib/stream/event-channel-service.ts` that verifies `getSession(true)`, rejects banned users, and enforces self/host/privileged authorization before delegating.
2. **Deterministic IDs Without `localeCompare`**:
   - Never derive a channel ID with `localeCompare` (ICU locale order differs across runtimes). Always use UTF-16 code-unit ordering (`a < b ? [a, b] : [b, a]`) via `lib/stream-channel-ids.ts` and `lib/stream-utils.ts`, capped at 64 chars.
3. **Tokens Require `iat` and Explicit TTL (`exp`)**:
   - Always pass both `exp` and `iat` (`Math.floor(Date.now() / 1000) - 60`) when minting chat or video tokens (`lib/stream-client.ts`). Stream rejects tokens without `iat` once `revoke_tokens_issued_before` is set on a user.
   - Video tokens are **app-wide user tokens** (`generateUserToken`) because `StreamVideoClient` is a tab-wide singleton. Call admission is enforced server-side by `resolveMeetingAccess` (`POST /api/meetings/[meetingId]/join`) plus `default` call-type role grants (`join-call` is stripped from `user`/`guest` and granted only to `call_member` and `co_presenter`). The join route never creates a call; provisioning is the only creator.
   - Stream accepts only `send-audio`, `send-video` and `screenshare` as per-user grants (`updateUserPermissions`), and one other name fails the whole request. Mute, pin and backstage come only from call-type role grants. `call_member` holds just the `-owner` variants of `update-call-permissions`, `mute-users` and `pin-call-track`. Accepted presenter collaborators join as the custom `co_presenter` role (mute, pin, backstage, publish; never `end-call` or `update-call-permissions`).
4. **Webhook Ingress & Multi-Secret HMAC**:
   - `/api/stream/webhooks` is exempt from `MAINTENANCE_MODE` (`lib/maintenance-edge.ts`) so Stream never trips its circuit breaker during maintenance windows.
   - Verify `X-Signature` against `STREAM_WEBHOOK_SECRET` with constant-time fallback to `STREAM_WEBHOOK_SECRET_PREVIOUS` (`lib/stream/webhook-signature.ts`).
   - Reject payloads older than 10 minutes (`MAX_WEBHOOK_AGE_MS = 10 * 60 * 1000`), deduplicate on `sha256(rawBody)` in `WebhookEvent`, reclaim stuck `PROCESSING` rows after 5 minutes (`STALE_PROCESSING_MS = 300_000`), and record failures outside rolled-back DB transactions.

---

## 4. 4-Part DM & Trial Policy + Contextual Booking Receipt Cards

1. **One Human Pair = One Canonical DM Channel**:
   - **B2C Personal Scope**: `dm-<a>-<b>` (or `dmh-<sha256>` if $> 64$ chars), `organization_id` omitted.
   - **B2B Enterprise Org Scope**: `dmo-<orgHash>-<pairHash>` with `custom.organization_id = orgId`.
   - Consultee-to-consultee peer DMs are prohibited (`canDirectMessage` in `lib/stream/dm-eligibility.ts` requires a consultant ↔ consultee link).
   - Legacy per-booking `consultation-*` and `subscription-*` channels are retired.
2. **Paid / Confirmed Gate (`DM_ELIGIBLE_STATUSES`)**:
   - `DM_ELIGIBLE_STATUSES = ["APPROVED", "SCHEDULED", "COMPLETED"]` (`lib/stream/dm-eligibility-statuses.ts`).
   - `APPROVED_PENDING_PAYMENT` and `PENDING` are strictly excluded.
3. **Webinars & Classes Provision Both Group Channel and 1:1 Host DM**:
   - Confirmed enrollment (`OPENABLE_EVENT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED"]`) provisions **both** the group `team` channel (`webinar-<id>` / `class-<id>`) **and** a 1:1 personal DM (`dm-` / `dmo-`) between the consultant and each confirmed enrollee.
   - `ACCEPTED` `PlanCollaborator` co-hosts are included in group event rosters (`lib/stream/event-channel-service.ts`) and preserved in `syncUserEventChannels` so co-hosts are never evicted.
4. **Free Trials (`TRIAL`) Block All Chat Surfaces**:
   - `TrialSession` bookings have all Stream Chat channels, 1:1 DMs, and in-call meeting chat blocked (`skipped: "trial_chat_blocked"` in `lib/payments/webhooks/handlers.ts`; in-call chat disabled in `MeetingRoom.tsx`).
5. **Contextual Booking Receipt Cards (`booking-ctx-`)**:
   - Calling `POST /api/stream/channels/open` with `contextAppointmentId` verifies the appointment links `(userId, counterpartyUserId)` and posts an idempotent message (`id: booking-ctx-${appointmentId}-${eventType}` / `buildBookingContextMessageId`, carrying `booking_context` metadata `booking_appointment_id`, `booking_type`, `booking_title`, `booking_starts_at`) into the shared 1:1 DM thread.

---

## 5. Elastic Session Envelope & 1-to-Many Stage Moderation

- **Join & Overrun Envelope (`lib/meetings/room-ready.ts`, `lib/meetings/duration-cap.ts`)**:
  - **Early Join (`T-15m`)**: `CONSULTEE_JOIN_WINDOW_MS = 15 * 60 * 1000` before `startsAt`.
  - **Overrun & Rejoin Grace (`T+30m`)**: `REJOIN_GRACE_MS = 30 * 60 * 1000` after `endsAt`. If a host accidentally ends a call before `endsAt` (`endedReason = "ended_early"`), re-clicking Join reopens a fresh `call_<id>-r<base36>` room.
  - **SFU Hard Duration Cap (`max_duration_seconds`)**: `clamp(bookedDuration + 45m, 45m, 12h)` plus `session.inactivity_timeout_seconds = 300`.
  - **Free `+15m` Host Extension (`POST /api/meetings/[meetingId]/extend`)**: Extends `max_duration_seconds` by `+900s` after verifying the consultant has no conflicting `AppointmentOccurrence` starting within 15 minutes; surfaced in `<OverrunBanner />` (`timer_ends_at` countdown).
- **Backstage & `<StageControls />` for Webinars and Classes**:
  - All sessions run on the `default` call type (`buildCallSettingsOverride`). Webinars and Classes enable Backstage (`join_ahead_time_seconds: 900`), default attendees to mic/camera off, and gate audio/video/screenshare behind `access_request_enabled: true`.
  - Hosts go live via `POST /api/meetings/[meetingId]/live` (`call.goLive()`) and manage hand-raises and speaker promotion via `<StageControls />`.
- **Attendance Outcome & Earnings Hold (`lib/booking/session-outcome.ts`, `scripts/earnings/release-earnings.ts`)**:
  - `RECONNECT_GRACE_MINUTES = 5` merges Wi-Fi drop gaps up to 5 minutes into continuous `MeetingPresence` intervals; overlapping host + learner presence inside `[startsAt - 15m, endsAt + 45m]` counts toward `deliveredMinutes`.
  - When local presence is incomplete, `queryCallParticipantSessions` (`lib/stream/call-presence.ts`) paginates Stream's participant sessions before classifying `HELD` (`COMPLETED`), `CUT_SHORT` (`AWAITING_HUMAN`), or `NO_SHOW_*` (`UNSETTLED_MISS`).
  - `release-earnings.ts` blocks payout release until **all** non-deleted occurrences of an appointment settle, and rescheduling calls `recomputeEarningsHold` to push out `holdUntil` on `ConsultantEarnings` and `OrganizationEarnings`.
  - `reconcile-orphaned-sessions.ts` orders candidates by `occurrence.endsAt: "asc"`, closes open `MeetingPresence` rows (`leftAt = endedAt`), and guards state updates with CAS `updateMany`.

---

## 6. Recordings Architecture & Replay Marketplace

- **Cloudflare R2 Streaming Multipart Upload (`lib/storage/r2-client.ts`, `lib/stream/recording-storage.ts`)**:
  - READY recordings play from Stream's signed CDN until the `transfer-recordings` job copies them into **Cloudflare R2** (SigV4 multipart in 10 MB parts, 20 GiB ceiling, HEAD-verified size). R2 is the only destination; a failed copy leaves the row READY.
  - Retention is platform-set (`lib/stream/recording-retention.ts`, daily `expire-recordings`): 1:1 +90d, subscription/trial 90d after it ends, webinar +365d, class 365d after its final session; published or purchased replays are exempt and an org's `streamRecordingRetentionDays` only shortens org recordings.
- **SSRF Allowlist & `TRANSFERRING` CAS Fence (`lib/stream/recording-transfer-service.ts`)**:
  - `validateStreamRecordingUrl` enforces an HTTPS SSRF hostname allowlist (`*.stream-io-cdn.com`, `*.getstream.io`, `*.amazonaws.com`) before fetching.
  - Transfers claim rows atomically via CAS (`status: { in: ["PENDING_TRANSFER", "FAILED"] } -> "TRANSFERRING"`), reclaim stale `TRANSFERRING` locks after 15 minutes, cap retries at `MAX_TRANSFER_ATTEMPTS = 5`, and compute `streamUrlExpiresAt` from `sessionEndedAt + 14d`.
- **Dashboard CRUD & Replay Marketplace (`components/recordings/*`, `app/explore/recordings/[slug]`)**:
  - `<RecordingPlayerModal />`: Shared in-app `<video>` player with playback speed controls, byte-range scrubbing, `<track kind="captions">` WebVTT subtitles, and toggleable transcript panel.
  - `<RecordingManageSheet />`: Consultant drawer to rename recordings, trigger manual R2 transfer, delete (guarded by atomic `hasBuyers` check against `RecordingPurchase`), upload 60s preview clips and transcripts, and publish/update/unpublish `RecordingListing` items.
  - Consultees access unlocked full-length replays on `/explore/recordings/[slug]` and in the consultee dashboard `"Purchased"` tab.

---

## 7. DPDP Privacy Compliance & Enterprise Organization Lifecycle

- **DPDP `STREAM_DATA_PROCESSING` Consent Gate**:
  - Enforced at 4 boundaries: (1) `upsertUsersToStream` filters unconsented users into `droppedIds`, (2) `assertCanMintToken` (`actions/stream/chat/stream.action.ts`) revokes tokens and throws `ConsentRequiredError`, (3) `resolveMeetingAccess` (`lib/meetings/access.ts`, `hasStreamConsent`) blocks `/api/meetings/[id]/join` with `consent_required`, and (4) `StreamProviderImpl` / `ChatUnavailable` / `MeetingRoom` present a 1-click consent prompt (`POST /api/user/privacy/consent`).
- **Right to Erasure (`principal:<userId>`)**:
  - `scrubUser` (`lib/compliance/erasure/scrub-user.ts`) invokes `eraseStreamPrincipalFootprint(userId)` to revoke tokens, remove channel memberships, delete user recordings from R2/Supabase, and call `chat.deleteUsers([userId], { user: "hard", messages: "hard", conversations: "hard" })`. Any transient Stream failure enqueues a `principal:<userId>` marker in `StreamRevocationRetry`, drained by `scripts/cleanup/retry-moderation-enforcement.ts`.
  - Soft-deleted users past the 30-day grace window are hard-deleted from Stream by `hardDeleteEligibleUsers` in `scripts/stream/stream-sync.ts`.
- **Enterprise Org Member Removal & `wind-down-deactivated-orgs`**:
  - Removing an enterprise org member (`lib/enterprise/member-removal.ts`) immediately revokes their Stream token and evicts them from org-tagged channels.
  - Deactivating or deleting an organization runs `jobs/stream/wind-down-deactivated-orgs.ts`, ending active org video calls (`endActiveStreamVideoCalls`) and freezing all org-tagged chat channels (`organization_id: orgId`).

---

## 8. Live Rate Limits, Pinned SDK Version Holds & Operator Commands

### Live Stream Rate-Limit Ceilings & Batch Pacing

- **Ceilings**: `DeleteUser: 60/min` · `DeleteChannels: 60/min` · `ExportUsers: 60/min` · `UpdateUsers: 300/min` · `UpdateUsersPartial: 300/min` · `SendMessage: 1000/min` · `QueryChannels: 10000/min`.
- **Batch Pacing Rule**: Always chunk `upsertUsers` and `channel.create` members at `100` (`createMemberChunk` / `addRemainingMembers`), page `queryChannels` at `30` (`queryChannelsPaged` sorted by `created_at: 1`), and enforce a **`10_000ms` delay between 100-item chunks** (`RATE_LIMIT_DELAY_MS = 10_000`) in `expire-event-channels.ts` and `stream-sync.ts`.

### Pinned SDK Versions (`.github/dependabot.yml` & `package.json`)

- **`@stream-io/node-sdk` (`0.8.10`)**: Server-side Video & App SDK. Verify `npx tsc --noEmit` on `updateCallMembers` call sites and `npx jest __tests__/stream/` before bumping.
- **`@stream-io/video-react-sdk` (`1.43.3`)**: Video client & WebRTC UI.
- **`stream-chat-react` (`14.12.1`)**: Chat React UI components (CSS v2 theming tokens imported in `providers/StreamProviderImpl.tsx`).
- **`stream-chat` held on `9.x` (`9.53.0`)**: `v10` is still RC with breaking `Channel.getConfig()` / `client.configs` removals.

### Operator Cutover & Verification Commands (`scripts/stream/ensure.ts`)

```bash
# 1. Dry-run control-plane check (app settings, billable permissions + -owner/-any-team suffixes across default/livestream/audio_room/development, 300s inactivity timeout)
npx tsx scripts/stream/ensure.ts

# 2. Apply control-plane hardening once /api/meetings/[meetingId]/{join,end} are deployed
npx tsx scripts/stream/ensure.ts --apply --routes-are-deployed

# 3. Verify / apply webhook event subscriptions
npx tsx scripts/stream/ensure-webhook-subscription.ts --apply
```
