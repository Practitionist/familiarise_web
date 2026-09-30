---
name: stream
description: Work on this repo's Stream.io integration — chat channels, video calls, tokens, webhooks, recordings, moderation, and the crons around them. Use when the user says "stream", "chat channel", "DM channel", "meeting", "video call", "call type", "stream token", "recording", "attendance", "no-show", "webhook not firing", or is touching lib/stream/, lib/stream-*.ts, actions/stream/, app/api/stream/, app/meetings/, or components/chat/.
---

# Stream SDK

Two products under one API key: **Stream Chat** (`stream-chat`, `stream-chat-react`) and
**Stream Video** (`@stream-io/video-react-sdk`, `@stream-io/node-sdk`). They share a user store,
a JWT signing secret, and a token-revocation flag — but bill separately (Chat by MAU, Video by
participant-minute).

Full audit and remediation plan: **issue #1134**.

## Verify against the live app before believing the code

This subsystem has repeatedly looked correct in code and been broken in production. Static
reading is not enough. Before claiming anything works:

```text
mcp__streamio__video_query_calls    {"ended_at": {"$exists": false}}
mcp__streamio__chat_query_channels  {"type": {"$eq": "messaging"}}
mcp__supabase__execute_sql          -- count Meeting/MeetingAttendance/WebhookEvent
netlify env:list --json | jq -r 'if type=="object" then keys[] else .[].key end'  -- keys only, never values
```

The 2026-08-12 audit found a **total, never-once-worked webhook outage** that no amount of code
reading would have surfaced: the handler was correct, the secret was simply not set in Netlify.

## Hard rules

**Never derive an ID with `localeCompare`.** It is ICU- and locale-dependent, so two environments
can produce different IDs from the same inputs. Use code-unit ordering: `a < b ? [a, b] : [b, a]`.
A commit that "standardized" this to `localeCompare` silently re-keyed every mixed-case DM pair and
orphaned their history. Channel-ID helpers live in `lib/stream-channel-ids.ts` and
`lib/stream-utils.ts` — all pattern detection goes through them, and the ceiling is 64 chars.

**Always pass `iat` when minting a token.** The signature is `createToken(userId, exp, iat)`.
Stream treats a token with no `iat` as **invalid** once `revoke_tokens_issued_before` is set for
that user — so an `iat`-less token plus one ban equals a permanent lockout. Un-revoking is explicit:
`revokeUserToken(id, null)`, and a deactivated user also needs `reactivateUser(id)`.

**Video tokens are APP-WIDE, by decision.** This rule used to say "scope video tokens to the call
with `generateCallToken({ call_cids })`". That wrapper was written and then deliberately removed —
`lib/stream-client.ts` explains why: the video client is an app-wide singleton holding one
user token, so per-call tokens would mean a second client per meeting. Access control is instead
call-type grants plus the server-side membership `POST /api/meetings/[meetingId]/join` writes after
`resolveMeetingAccess` passes. **Always pass `iat`**, per the rule above. App-side checks alone are
not access control; Stream's server API deliberately bypasses its own permission system.

**The call-type grants are an OPERATOR ACTION, not a done change.** The `call_member` hardening
(`join-call` and recording control moved off the roles the join route hands to every participant)
exists as a _remediation script_ and a _detector_, not as applied state:
`scripts/stream/ensure-call-type-grants.ts` is dry-run by default, and
`.github/workflows/stream-calltype-drift.yml` runs every script in `--check` mode, which never
writes. Applying is deliberately left to a human — `--apply` mutates a shared production Stream app
with no rehearsal environment and additionally demands `--routes-are-deployed`, an assertion about
this repo's deploy a job cannot make. So a green drift check means "the live call type matches the
script", **not** "the hardening has been applied". Run
`backfill-call-member-role.ts` first; the grants pre-flight refuses to apply until an open call
actually holds a `call_member` member.

**Webhooks must ack first.** Stream retries within a **15-second total budget** (6s per attempt) and
then drops the event forever. Verify the signature, persist the `WebhookEvent` receipt, acknowledge,
then process in `after()`. Stream signs with the **API secret**; there is no separate signing secret.

**Dedup on `sha256(body)`, NOT on `X-Webhook-ID`.** This rule used to say the opposite. The header is
not covered by the signature — Stream signs the body only — so one captured `(body, signature)` pair
replays under N invented header values and mints N dispatches from one verified delivery. The body
hash collapses genuine retries (byte-identical) and separates genuine events (they differ somewhere),
which is everything the header was wanted for. The derivation is
`app/api/stream/webhooks/route.ts:254-274`; the dedup gate that consumes `isNew` is at `:380-391`;
and the deviation is pinned by `__tests__/stream/webhook-dedup-and-replay.test.ts` ("derives the key
from the body, not from a header", "collapses a byte-identical replay under N DIFFERENT webhook
ids"), so reverting it means deleting a test that explains why. Razorpay refuses
`x-razorpay-event-id` for the same underlying reason but prefers a business-entity id from the
payload over a body hash.

**Use the SDK's `verifySignature(body, signature, secret)`**, not a hand-rolled `createHmac` +
`timingSafeEqual`. Do **not** reach for `verifyAndParseWebhook`: it returns only the parsed `Event`
and not the uncompressed bytes, so the dedup key above would have to be re-derived by re-serialising —
and `JSON.stringify` is not byte-stable.

**`call_cid` is `type:id`.** Split it in exactly one helper. Sites that forget produce silent 404s
that get recorded as `UNVERIFIED` completions.

**Never `await` a Stream call inside a DB transaction**, and never leave channel provisioning as
`void (async () => {…})()` — the Lambda can freeze before it settles. It needs an outbox.

**Versions are pinned EXACTLY** since #1282 — no carets. `@stream-io/video-filters-web` is a hard
dependency of the video SDK and is already on disk, so background blur needs no install; only
`@stream-io/audio-filters-web` does, and that one is a **paid** add-on billed per participant-minute.
`noise_cancellation` on the `default` call type is **`available`**, not `auto-on` — #1285 changed it
precisely so that shipping Krisp does not start the meter by itself.

**What is actually installed** (read `package.json`; do not trust a version list in prose, and
treat any "#NNNN records a deliberate hold" claim you cannot find in the repo as unverified —
nothing in this repository mentions #1283):

| Package                      | Installed |
| ---------------------------- | --------- |
| `@stream-io/node-sdk`        | `0.7.64`  |
| `@stream-io/video-react-sdk` | `1.42.0`  |
| `stream-chat`                | `9.52.0`  |
| `stream-chat-react`          | `13.14.6` |

`@stream-io/video-filters-web` is **not** a direct dependency; it is on disk at `0.8.7` as a
transitive dep of the video SDK, which is why background blur needs no install. That is also the
reason to treat the transitive version as a courtesy rather than a pin — an SDK bump can move it.

**The CSP blocker for filters is `connect-src`, not `worker-src`.** Both filter
packages fetch WASM and models from `unpkg.com` at runtime unless `basePath` is
set. Neither constructs a `Worker`; Krisp uses an AudioWorklet, which CSP checks
under `script-src`.

## Where things live

| Concern                                                | File                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server clients + tokens + Stream's OWN circuit breaker | `lib/stream-client.ts`                                                                                                                                                                                                                                                                                                                                                                                                                |
| Token server actions (session-bound)                   | `actions/stream/chat/stream.action.ts`                                                                                                                                                                                                                                                                                                                                                                                                |
| Channel create / membership                            | `actions/stream/chat/channel.action.ts`                                                                                                                                                                                                                                                                                                                                                                                               |
| Lazy channel sync + reconcile                          | `actions/stream/chat/event-channel.action.ts`                                                                                                                                                                                                                                                                                                                                                                                         |
| Channel ID derivation                                  | `lib/stream-channel-ids.ts`, `lib/stream-utils.ts`                                                                                                                                                                                                                                                                                                                                                                                    |
| Call creation                                          | `lib/meeting.ts`, `actions/stream/meetings/meeting.action.ts`                                                                                                                                                                                                                                                                                                                                                                         |
| Client connection (store, not wrapper)                 | `providers/StreamProviderImpl.tsx`, `lib/stream/connection-store.ts`                                                                                                                                                                                                                                                                                                                                                                  |
| Webhooks                                               | `app/api/stream/webhooks/route.ts` → `lib/stream/webhook-dispatch.ts` → `lib/stream/{session,recording}-handlers.ts`                                                                                                                                                                                                                                                                                                                  |
| Recordings                                             | `lib/stream/recording-service.ts`, `recording-transfer-service.ts`                                                                                                                                                                                                                                                                                                                                                                    |
| Replay marketplace (#366)                              | `lib/data/recordings-explore.ts`, `app/api/stream/recordings/[recordingId]/{publish,preview}`, `app/api/recordings/[recordingId]/purchase`, `lib/payments/webhooks/recording-purchase.ts`, `docs/stream/recordings-marketplace.md`                                                                                                                                                                                                    |
| Media teardown                                         | `lib/stream/media-teardown.ts`                                                                                                                                                                                                                                                                                                                                                                                                        |
| Crons (12 workflows)                                   | `.github/workflows/` — `stream-sync.yml`, `stream-webhook-drift.yml`, `stream-calltype-drift.yml`, `mark-expired-recordings.yml`, `transfer-expiring-recordings.yml`, `cleanup-old-stream-recordings.yml`, `reconcile-orphaned-recordings.yml`, `reconcile-orphaned-sessions.yml`, `expire-event-channels.yml`, `sweep-stuck-webhook-events.yml`, `archive-webhook-events.yml`, `stream-calltype-drift.yml`, `stream-usage-meter.yml` |

Prisma: `Meeting` (1:1 with `AppointmentOccurrence` via `appointmentOccurrenceId @unique`,
`streamCallId` unique, denormalized `organizationId`), `MeetingAttendance` (unique on meeting+user),
`MeetingPresence` (per-device join/leave intervals, #1569), `Recording`, `RecordingConsent` (#1134
P1-7). **No chat state is stored in Postgres** — channels live only on Stream, which is why a bad
channel-ID derivation is unrecoverable data loss.

**The room id is derived, not generated:** `occurrence-<occurrenceId>`, or
`occurrence-<occurrenceId>-r<base36>` after a #1607 pre-start-end rebuild. Build and parse in
`lib/meetings/room-id.ts`. `appointmentOccurrenceId` is the durable key; the room id can change
under an open tab. Live calls minted before the rename still carry legacy `slot-<uuid>` ids and
nothing backfills them — treat those as legacy, not as a second live format.

## Traps that have bitten before

- **`ssr: false` skips the component _and its children_.** The provider must render `null` as a
  sibling of `children` and publish to a store, never wrap them — wrapping cost the whole dashboard
  its server-rendered HTML and caused a remount storm.
- **Changing the element type at a position remounts the subtree.** Commit both clients at once.
- **`queryChannels` is capped at 30 per call**, not whatever `limit` you pass. A `do…while
(page.length === PAGE_SIZE)` loop with `PAGE_SIZE = 100` exits after one page and silently
  reconciles only the first 30 memberships.
- **In-memory caches are per-process** and near-useless on serverless; module-level `Set`s used as
  dedup guards grow unbounded.
- **Stream and Redis have SEPARATE breakers** since #1280. They shared one, so five Stream failures
  opened the breaker booking-lock acquisition also went through — a video outage stopped checkout,
  and a Redis outage reported as "Video is temporarily unavailable". Take an instance from
  `createCircuitBreaker(name)` for any new backing service; do not reuse `withCircuitBreaker`, which
  is Redis's.
- **A breaker fallback SWALLOWS the rejection.** `withCircuitBreaker(op, () => x)` returns `x`
  instead of throwing, so a `catch` that was meant to record the failure never runs. Omit the
  fallback and catch, when the point is to degrade _and_ report.
- **`upsertUsers` and `channel.create()` take the whole member array in one request.** Chunk them
  before a 100+ attendee webinar.
- Test with `mcp__streamio__*` against the shared app carefully — **dev, preview and prod currently
  share one Stream app**, so a "test" deletion is a real deletion.

## Docs

`docs/stream/` — 22 markdown files plus `stream-ecosystem.mmd`. `README.md` is the index and states
the house rule: where a document and the code disagree, the code is correct and the document is a bug
worth fixing in place. `troubleshooting.md` and `13-recording-webhooks.md` are the densest.

Two traps that cost a full outage each, both of which these docs used to teach: Stream signs webhooks
with the **API secret** (there is no dashboard "signing secret"), and the dedup key is
`sha256(body)`, not `X-Webhook-ID`. If you are reading a page that says otherwise, that page is
stale — fix it rather than following it.
