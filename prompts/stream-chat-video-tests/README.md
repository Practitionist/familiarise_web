# Stream Video, Stream Chat & Scheduling Concurrency — Exhaustive E2E QA Prompt Suite

> **Target Environment:** Live **Netlify Deploy Previews** (`https://deploy-preview-<PR>--familiarise.netlify.app` or `https://dev--familiarise.netlify.app`) — **NEVER `localhost` (`next dev`)**.
> **MCP Tool Stack:**
> - **Chrome DevTools MCP** (`mcp__chrome-devtools__*`) — Real browser session injection (`__Secure-better-auth.session_token`), dashboard clicks, backstage/room verification, network/console inspection, screenshots.
> - **Supabase MCP** (`mcp__supabase__execute_sql` on project `pzmbxqdgibfkhjwzeprf`) — Mock data CRUD, sequential non-overlapping live window shifting, `BEGIN ... ROLLBACK` kernel constraint probes (`23P01`, `23514`), and post-action DB assertions.
> - **Stream IO MCP** (`mcp__stream-io__*` on App `1366319`) — Live inspection of `default:occurrence-<slotId>` calls, `settings_override`, `co_presenter` / `call_member` grants, and `messaging` / `team` chat channels.
> - **Sentry MCP** (`mcp__sentry__*`) — Unhandled error sweep across server, edge, and browser runtimes.

---

## Shared Single-Source-of-Truth (SSOT) Files

Every subagent launched on any prompt file in this suite **must** read these three shared contracts first:
1. **[`_shared/shared-setup.md`](./_shared/shared-setup.md)** — Non-negotiable execution rules (zero local servers, paise integers, camelCase vs snake_case `organizationId` dichotomy, seed cohort IDs, 7 core architectural invariants `INV-VIDEO-01`..`INV-SCHED-01`, and primary codebase anchors).
2. **[`_shared/mcp-recipes.md`](./_shared/mcp-recipes.md)** — Exact copy-paste recipes for Better Auth HMAC-SHA256 cookie signing & injection on `*.netlify.app`, non-overlapping live time-window shifting, `BEGIN ... ROLLBACK` constraint probes, Stream IO MCP inspection, and Sentry telemetry sweeps.
3. **[`_shared/case-template.md`](./_shared/case-template.md)** — Per-workflow structural standard and the mandatory JSON **`QA_WORKFLOW_FAILURE_REPORT`** schema that subagents emit back to the main agent whenever any workflow fails.

---

## Complete Suite Architecture & Priority Matrix (10 Prompt Files · 47 E2E Workflows)

| Priority Tier | Prompt File | Workflows | Key Subsystem & Regression Coverage |
| :--- | :--- | :---: | :--- |
| **P0 Common** | [`0-common-p0-journeys/0.1-one-to-one-consultation-and-subscription-join.md`](./0-common-p0-journeys/0.1-one-to-one-consultation-and-subscription-join.md) | 5 | Consultee-first vs Host-first 1:1 join (`created_by.id` = Consultant), multi-slot `SUBSCRIPTION` `occurrence-<slotId>` isolation, `+30m` grace rejoin, `-15m` early gate (`403 early`) |
| **P0 Common** | [`0-common-p0-journeys/0.2-one-to-many-webinar-and-class-join-and-backstage.md`](./0-common-p0-journeys/0.2-one-to-many-webinar-and-class-join-and-backstage.md) | 5 | Issue #2010 / PR #2012 `WEBINAR` & `CLASS` video join, `target_resolution` + `audio.default_device` contract, backstage holding room (`isAwaitingHostGoLive`), host `goLive()` (`/live`), late join |
| **P0 Common** | [`0-common-p0-journeys/0.3-trial-session-video-and-chat-restrictions.md`](./0-common-p0-journeys/0.3-trial-session-video-and-chat-restrictions.md) | 4 | Free `TRIAL` 1:1 video join, strict client + server in-call chat disablement (`allowInCallChat = false`), trial DM blocking, post-trial conversion unlock |
| **P1 Roles & Org** | [`1-roles-collaborators-and-permissions/1.1-co-presenter-and-moderator-stage-controls.md`](./1-roles-collaborators-and-permissions/1.1-co-presenter-and-moderator-stage-controls.md) | 5 | `CO_HOST` / `CO_INSTRUCTOR` `co_presenter` Stream role & fallback (`!isUnknownRoleRejection`), `MODERATOR` video-vs-chat split, `/stage` `grant`/`revoke` (`STREAM_PUBLISH_PERMISSIONS`) |
| **P1 Roles & Org** | [`1-roles-collaborators-and-permissions/1.2-collaborator-lifecycle-and-chat-sync.md`](./1-roles-collaborators-and-permissions/1.2-collaborator-lifecycle-and-chat-sync.md) | 4 | `withSerializableRetry` collaborator invite/accept, `collaborator_one_presenter_*` unique indexes, `MIN_HOST_SHARE_BPS = 1000`, overlap check, chat channel sync |
| **P1 Roles & Org** | [`1-roles-collaborators-and-permissions/1.3-enterprise-org-scoping-and-dpdp-consent.md`](./1-roles-collaborators-and-permissions/1.3-enterprise-org-scoping-and-dpdp-consent.md) | 4 | DPDP `STREAM_DATA_PROCESSING` `403 CONSENT_REQUIRED` inline 1-click consent recovery, `Meeting.organizationId` triggers, cross-org IDOR `403 forbidden` |
| **P2 Live Controls** | [`2-live-room-lifecycle-and-controls/2.1-session-duration-cap-and-host-extend.md`](./2-live-room-lifecycle-and-controls/2.1-session-duration-cap-and-host-extend.md) | 4 | `resolveMaxCallDurationSeconds` (`[45m, 12h]`), `+15m` host `/extend`, `409 hasConflictingNextBooking` across host/participant/co-host, post-grace `callHasLiveParticipants` vs `410 closed` |
| **P2 Live Controls** | [`2-live-room-lifecycle-and-controls/2.2-recording-waitlist-end-call-and-webhooks.md`](./2-live-room-lifecycle-and-controls/2.2-recording-waitlist-end-call-and-webhooks.md) | 5 | Recording atomic CAS + `409 CONSENT_DECLINED` opt-out, `endCall` (`410 ended`) vs `leaveCall`, `ended_early` `-r<ts>` re-provisioning, webhook gzip/HMAC/attendance/stale dead-lettering |
| **P2 Chat & Mod** | [`3-stream-chat-channels-and-moderation/3.1-dm-event-channels-slow-mode-and-freeze.md`](./3-stream-chat-channels-and-moderation/3.1-dm-event-channels-slow-mode-and-freeze.md) | 5 | `POST /api/stream/channels/open` DM eligibility, `team:webinar-<id>` / `team:class-<id>`, `cooldown: 3` slow mode, `STREAM_SERVER_TRUSTED` symbol boundary, `chatFrozenAt` retention & 48h wind-down |
| **P3 Concurrency & Impossible** | [`4-concurrency-edge-and-impossible-cases/4.1-consultant-cross-type-concurrency-and-constraints.md`](./4-concurrency-edge-and-impossible-cases/4.1-consultant-cross-type-concurrency-and-constraints.md) | 5 | Issue #2010 Part 2 `occurrence_no_confirmed_overlap` (`23P01`) across all 5 types, `occurrence_confirmed_requires_consultant_chk` (`23514`), owner `PATCH` cascade, class make-up `23P01`->`409`, tombstone exemptions |
| **P3 Concurrency & Impossible** | [`4-concurrency-edge-and-impossible-cases/4.2-self-healing-orphan-rooms-and-impossible-states.md`](./4-concurrency-edge-and-impossible-cases/4.2-self-healing-orphan-rooms-and-impossible-states.md) | 6 | `409 ROOM_NOT_PROVISIONED` auto-heal, direct `/meetings/occurrence-<uuid>` `404 not_found` auto-heal, double-click `inFlightRef` + `P2002` idempotency, `CORRUPT_SLOT_FALLBACK_SECONDS`, circuit-breaker `503`, cross-midnight UTC |

---

## Multi-Agent Parallel Sharding Guide

When executing this suite against a PR deploy preview (`https://deploy-preview-<PR>--familiarise.netlify.app`), spawn **4 parallel QA subagents** (`invoke_subagent`) partitioned by non-conflicting fixture windows:
- **Subagent Shard A (P0 Core Video & Trial):** Executes `0.1`, `0.2`, `0.3` using staggered windows on `Aarav Anderson -> Abhinav` seed cohort (`mcp-recipes.md §3`).
- **Subagent Shard B (P1 Roles, Collaborators & Enterprise/Consent):** Executes `1.1`, `1.2`, `1.3` using `WebinarCollaborator` / `ClassCollaborator` and org cohorts (`wipro`, `learnpro-academy`).
- **Subagent Shard C (P2 Live Controls, Webhooks & Stream Chat):** Executes `2.1`, `2.2`, `3.1`.
- **Subagent Shard D (P3 Concurrency Constraints, Self-Heal & Impossible States):** Executes `4.1`, `4.2` using `BEGIN ... ROLLBACK` SQL probes and ephemeral `qa-scv-*` rows.
