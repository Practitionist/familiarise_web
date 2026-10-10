# Stream

Stream provides two products in this application under a single API key. Stream
Chat backs direct messages, event channels, and collaborator threads. Stream
Video backs live meeting rooms and cloud recordings. They share a user store, a
JWT signing secret, and a token-revocation timestamp
(`revoke_tokens_issued_before`), while billing on independent meters — Chat by
monthly active user (MAU), Video by participant-minute.

## Read the code before you trust a document

This subsystem enforces strict server-side invariants across Stream control-plane
settings, Cloudflare R2 object storage, and PostgreSQL (`PG_POOL_MAX=1`) state
transitions. Verify live control-plane settings when diagnosing environment
behavior:

```text
mcp__stream-io__video_query_calls    {"filter_conditions": {"ended_at": {"$exists": false}}}
mcp__stream-io__chat_query_channels  {"filter_conditions": {"type": {"$eq": "messaging"}}}
mcp__stream-io__video_get_call_type  {"name": "default"}
netlify env:list --json
```

## The documents

The numbered files (`00` through `18`) follow strict contiguous numbering and are meant to be read in sequence by engineers onboarding onto the real-time subsystem. The unnumbered documents serve as targeted subsystem runbooks and visual maps.

| Document                                                                     | What it covers                                                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [00-pricing-overview.md](./00-pricing-overview.md)                           | Stream billing meters and which product surface increments each meter.                                     |
| [01-architecture.md](./01-architecture.md)                                   | End-to-end HLD & LLD: App Router, Stream SFU/Chat, Postgres models & CAS invariants, R2 storage, and crons |
| [02-setup-configuration.md](./02-setup-configuration.md)                     | Environment variables, control-plane bootstrap, and the hardened `default` call type (`call_member`).      |
| [03-provider-authentication.md](./03-provider-authentication.md)             | Client connection store, SDK-free shell provider split, and session hydration gating.                      |
| [04-chat-implementation.md](./04-chat-implementation.md)                     | Channel shapes, human-pair DM derivation (`dm-`/`dmo-`), and contextual booking receipt cards.             |
| [05-video-implementation.md](./05-video-implementation.md)                   | Session window math, synchronous end + reopen rotation, `+15m` extensions, exit UX, lobby gate, and Q&A.   |
| [06-channel-management.md](./06-channel-management.md)                       | 4-part DM eligibility gates, event channel rosters, and collaborator synchronization.                      |
| [07-user-management.md](./07-user-management.md)                             | Upserting principals into Stream, PII stripping, least-privilege role mapping, and DPDP erasure.           |
| [08-token-management.md](./08-token-management.md)                           | Minting, caching, `iat`/`exp` revocation cutoffs, and moderation enforcement.                              |
| [09-background-sync.md](./09-background-sync.md)                             | Scheduled user synchronization, stale principal cleanup, and orphaned session/recording sweeps.            |
| [10-api-endpoints.md](./10-api-endpoints.md)                                 | Meeting lifecycle routes (`join`, `end`, `reopen`, `live`, `extend`, `qa`) & Stream REST reference.        |
| [11-hooks-utilities.md](./11-hooks-utilities.md)                             | Client hooks (`useGetCallById` self-heal & lobby gate) and call-ID / timezone utility contracts.           |
| [12-error-handling.md](./12-error-handling.md)                               | Server circuit breaker (`withStreamCircuitBreaker`), failure modes, and UI error boundaries.               |
| [13-recording-webhooks.md](./13-recording-webhooks.md)                       | Recording lifecycle, asymmetric webhook resolution, R2 multipart transfer, and retention rules.            |
| [14-pricing-and-cost-model.md](./14-pricing-and-cost-model.md)               | Detailed unit economics and cost projections across session types.                                         |
| [15-enterprise-and-maker-account.md](./15-enterprise-and-maker-account.md)   | Plan tiers, enterprise org wind-down, and Maker account capabilities.                                      |
| [16-product-concepts-and-addons.md](./16-product-concepts-and-addons.md)     | Stream product concepts, SFU capabilities, and paid add-on boundaries.                                     |
| [17-channel-lifecycle.md](./17-channel-lifecycle.md)                         | Chat channel provisioning, post-session freeze windows, and automated deletion.                            |
| [18-architecture-decision-records.md](./18-architecture-decision-records.md) | Authoritative ADRs (`ADR-01`..`ADR-05`): call isolation, ID rotation, CAS termination, extensions & UX.    |
| [troubleshooting.md](./troubleshooting.md)                                   | Production diagnostic runbook for symptoms, root causes, and live MCP checks.                              |
| [recordings-marketplace.md](./recordings-marketplace.md)                     | Replay marketplace storefront, entitlements, and 60s preview clips.                                        |
| [stream-ecosystem.mmd](./stream-ecosystem.mmd)                               | Full Mermaid ecosystem diagram across business entities, Stream, Postgres, and Cloudflare R2.              |

## Core Architectural Rules

Each invariant below is strictly enforced across `lib/stream/`, `lib/meetings/`, `app/api/meetings/`, and `.claude/skills/stream/SKILL.md`:

1. **One `AppointmentOccurrence` = One Active Stream Call (`ADR-01`)**: Every scheduled occurrence maps 1:1 to a `Meeting` row (`appointmentOccurrenceId @unique`) with a canonical bare call ID (`occurrence-<uuid>`, rotating to `occurrence-<uuid>-r<base36>` on pre-start device-test reset or host reopen). Stale links resolve transparently via `parseOccurrenceIdFromCallId`.
2. **Never Derive Identifiers with `localeCompare`**: Always use UTF-16 code-unit ordering (`a < b ? [a, b] : [b, a]`) via `lib/stream-channel-ids.ts` and `lib/stream-utils.ts`, capped at 64 characters.
3. **Tokens Require Both `iat` and `exp`**: Stream invalidates tokens lacking `iat` whenever `revoke_tokens_issued_before` is set on a user.
4. **Never Invoke External Stream RPCs Inside `prisma.$transaction` (`PG_POOL_MAX=1`)**: Execute all Stream SDK network calls outside transactions via `withStreamCircuitBreaker`, and persist Postgres transitions atomically via conditional `updateMany` compare-and-set (CAS) predicates.
5. **Asymmetric Webhook Lookup & Monotonic Convergence (`ADR-02` & `ADR-03`)**: `call.ended` and `call.session_ended` webhooks match strictly on `where: { streamCallId }` and advance monotonically (`supersedesRecordedEnd`), while `recording_ready`, `recording_failed`, and `participant_*` webhooks fall back to `appointmentOccurrenceId` so pre-reopen artifacts and attendance intervals are never lost.
6. **Shared Stream Application Across Environments (`app_id: 1366319`)**: Keep `STREAM_MCP_READ_ONLY="true"` in `.mcp.json`.

## Related

- [18. Architecture Decision Records (`ADR-01` through `ADR-05`)](./18-architecture-decision-records.md)
- `.claude/skills/stream/SKILL.md` — Operational engineering skill synchronized with the live codebase.

## Deprecated & Superseded Approaches

- **Header-based webhook deduplication (`X-Webhook-ID`)**: Superseded by `sha256(rawBody)` deduplication in `WebhookEvent` and constant-time multi-secret HMAC signature verification (`lib/stream/webhook-signature.ts`).
- **Browser-side `call.getOrCreate()`, `call.endCall()`, and permissive `user`/`guest` `join-call` grants**: Superseded by server-only `provisionAppointmentMeeting`, `POST /api/meetings/[meetingId]/join`, `POST /api/meetings/[meetingId]/end`, and `POST /api/meetings/[meetingId]/reopen`.
- **Webhook-only `Meeting.endedAt` writes on host end**: Superseded by synchronous CAS dual-write (`recordMeetingEndedSynchronously`) in `POST /api/meetings/[meetingId]/end` paired with monotonic `call.ended` convergence so dashboard states update on the first frame.
