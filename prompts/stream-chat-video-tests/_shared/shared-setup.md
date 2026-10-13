# Stream Video, Stream Chat & Scheduling Concurrency — Shared Setup & Constitution

> **Single Source of Truth (SSOT):** Every prompt in `prompts/stream-chat-video-tests/`
> inherits the rules, personas, invariants, and code anchors defined in this file.
> If a case file conflicts with this constitution, **this file wins**.

---

## §1. Critical Execution Rules (Non-Negotiable)

1. **Zero Local Servers — Netlify Deploy Preview Only:**
   - **NEVER** start `next dev`, `next start`, or any `localhost` web server (`pkill -f "next dev" || true` if any stray process exists).
   - Always execute UI and `fetch()` probes against a live **Netlify Deploy Preview** (`https://deploy-preview-<PR>--familiarise.netlify.app`) or the deployed `dev` branch URL (`https://dev--familiarise.netlify.app`).
2. **Double-Quote Mixed-Case Prisma Tables vs Lowercase Better Auth / Org Tables:**
   - Mixed-case Prisma models in `execute_sql` **must** be double-quoted:
     `"Appointment"`, `"AppointmentOccurrence"`, `"AppointmentParticipant"`, `"Meeting"`, `"Consultation"`, `"Subscription"`, `"Webinar"`, `"Class"`, `"TrialSession"`, `"Collaborator"`, `"ConsentArtifact"`, `"ConsultantProfile"`, `"ConsulteeProfile"`, `"Recording"`, `"WebinarWaitlist"`.
   - Better Auth and mapped enterprise tables are **lowercase**:
     `users`, `sessions`, `accounts`, `organizations`, `members`, `invitations`.
3. **Money Strictly in Integer `paise`:**
   - Never divide or store fractional rupees. All amounts in DB assertions are integers (`paise`).
4. **Casing Dichotomy in Stream Metadata:**
   - **Stream Video Call (`default:occurrence-<slotId>`):** `call.custom.organizationId` uses **camelCase**.
   - **Stream Chat Channel (`messaging:dm-...`, `team:webinar-...`, `team:class-...`):** `channel.data.organization_id` uses **snake_case**.
5. **Non-Overlapping Time Windows (`occurrence_no_confirmed_overlap` GiST Constraint):**
   - PostgreSQL enforces single-active-session concurrency across **all 5 appointment types** (`CONSULTATION`, `SUBSCRIPTION`, `WEBINAR`, `CLASS`, `TRIAL`) via GiST exclusion constraint `occurrence_no_confirmed_overlap` (`SQLSTATE 23P01`) and check constraint `occurrence_confirmed_requires_consultant_chk` (`SQLSTATE 23514`).
   - Whenever creating or shifting live test occurrences for a consultant, allocate **sequential non-overlapping half-open windows** (`[T, T+30m)`, `[T+45m, T+105m)`, etc.) unless a case explicitly tests constraint rejection inside a `BEGIN ... ROLLBACK;` block.

---

## §2. Target Infrastructure & Seed Personas

### Infrastructure Identifiers
| Component | Identifier / Endpoint |
| :--- | :--- |
| **Target App URL** | `https://deploy-preview-<PR>--familiarise.netlify.app` |
| **Supabase Project ID** | `pzmbxqdgibfkhjwzeprf` |
| **Stream IO App ID** | `1366319` (`gcp-us-east5.c1`) |
| **Stream Call Type** | `default` (`call_id = "occurrence-" || slotOfAppointmentId`) |
| **Stream Chat Channel Types** | `messaging` (1:1 DMs), `team` (`webinar-<id>`, `class-<id>`) |

### Primary Test Personas (Seed Cohort — Restore Any Shifted Windows After Destructive Tests)
| Role | Name | Email | `users.id` | Profile ID (`ConsultantProfile` / `ConsulteeProfile`) |
| :--- | :--- | :--- | :--- | :--- |
| **Primary Consultant (Host)** | Aarav Anderson | `aarav.anderson@gmail.com` | `cmu15jwjr0000c7yobiusdtlt` | `consultantProfileId = 314eecae-2d84-453b-8f24-825519a3ebb1` |
| **Primary Consultee (Attendee)** | Abhinav | `abhinav10229@gmail.com` | `euyQyTP7LYjIqguPZWtWOyE5mYl86ud4` | `consulteeProfileId = 12cb2c39-e7ca-4ec0-b72b-1a19257c9c44` |
| **Enterprise Sponsor Owner (`wipro`)** | Tour Owner | `tour-owner@familiarise.dev` | *(lookup via `users`)* | `organizations.slug = 'wipro'` (`canSponsor=true, canHost=false`) |
| **Enterprise Host Org (`learnpro-academy`)** | LearnPro Admin | *(lookup via `members`)* | *(lookup via `users`)* | `organizations.slug = 'learnpro-academy'` (`canSponsor=false, canHost=true`) |
| **Enterprise Hybrid Org (`iit-madras`)** | IIT Madras Admin | *(lookup via `members`)* | *(lookup via `users`)* | `organizations.slug = 'iit-madras'` (`canSponsor=true, canHost=true`) |

### Canonical Seeded Appointments & Occurrences (Aarav -> Abhinav)
| Offering Type | Parent `Appointment.id` | `AppointmentOccurrence.id` (`slotOfAppointmentId`) | Canonical `streamCallId` |
| :--- | :--- | :--- | :--- |
| **Webinar (`WEBINAR`)** | `d385a714-334c-4623-9160-bd9cc6d60e6f` | `e2ccb6d2-26b3-4860-9f27-336af511bf21` | `occurrence-e2ccb6d2-26b3-4860-9f27-336af511bf21` |
| **Class (`CLASS`)** | `04af0041-455f-4d48-b165-2513c4176941` | `7b778b43-53ca-4e4b-992e-34f5d4f201c2` | `occurrence-7b778b43-53ca-4e4b-992e-34f5d4f201c2` |
| **Consultation (`CONSULTATION`)** | `213009ac-b2f5-4c00-a3cf-388097027c72` | `635b4463-e2d9-4890-a9d2-4cfb76d39838` | `occurrence-635b4463-e2d9-4890-a9d2-4cfb76d39838` |
| **Subscription (`SUBSCRIPTION`)** | `575d8561-106b-438a-8114-1fb9f41122a4` | `3944f90f-592f-42d0-b805-d66c509c0738` | `occurrence-3944f90f-592f-42d0-b805-d66c509c0738` |

---

## §3. Mock-Data & Ephemeral Fixture Isolation Rules

1. **Deterministic Suffix for Ephemeral Entities:**
   - Any ephemeral user, consultation, webinar, class, occurrence, or meeting created for destructive/impossible cases must use ID/slug prefix `qa-scv-<YYYYMMDD>-<caseId>-*`.
2. **Isolated Constraint Testing (`BEGIN ... ROLLBACK`):**
   - When verifying database check/exclusion constraints (`occurrence_no_confirmed_overlap`, `occurrence_confirmed_requires_consultant_chk`), execute the invalid `INSERT`/`UPDATE` inside an explicit `BEGIN; ... ROLLBACK;` block or catch the exact Postgres `SQLSTATE` (`23P01` / `23514`) without polluting persistent seed rows.
3. **Mandatory Post-Case Cleanup:**
   - Delete ephemeral rows in strict reverse foreign-key order:
     `"Recording"` -> `"Meeting"` -> `"AppointmentParticipant"` -> `"AppointmentOccurrence"` -> `"Appointment"` -> offering plan -> `"organizations"` (where `slug LIKE 'qa-scv-%'`).

---

## §4. Core Architectural Invariants (Pinned Regression Contracts)

1. **INV-VIDEO-01 — Complete CallSettingsOverride Contract (`lib/meetings/call-settings.ts`):**
   - `buildCallSettingsOverride()` must ALWAYS satisfy Stream `@stream-io/node-sdk` strict object validators:
     - `video.target_resolution` includes `{ width: 1280, height: 720, bitrate: 2500000 }`.
     - `audio` includes `default_device: "speaker"`.
     - `limits.max_duration_seconds` = `clamp(bookedDurationSeconds + 2700, 2700, 43200)`.
     - Group events (`WEBINAR`, `CLASS`) enable `backstage: { enabled: true, join_ahead_time_seconds: 900 }`; 1:1 sessions disable backstage (`enabled: false`).
2. **INV-VIDEO-02 — Host Ownership & Full Room Provisioning (`actions/stream/meetings/meeting.action.ts`):**
   - Even when a **consultee** clicks `Join` first (`getOrCreateAppointmentMeeting` -> `provisionAppointmentMeeting`), `created_by_id` on the Stream call MUST be the resolved **consultant host's `userId`**, NEVER the consultee's `userId`.
   - `POST /api/meetings/[meetingId]/join` never silently mints a bare, unconfigured call via `getOrCreate({ created_by_id: caller })`; if the Stream room is missing (`404`), it returns `409 { code: "ROOM_NOT_PROVISIONED" }` so the client auto-heals via `provisionAppointmentMeeting()`.
3. **INV-VIDEO-03 — Dual Client Auto-Heal (`useGetCallById.ts` & `useLazyJoinMeeting.ts`):**
   - **Heal Path A (`409 ROOM_NOT_PROVISIONED`):** DB `Meeting` row exists, Stream call missing -> calls `provisionAppointmentMeeting({ appointmentId, slotOfAppointmentId: occurrenceId })`, then retries `/join`.
   - **Heal Path B (`404 not_found` on `/meetings/occurrence-<uuid>`):** Direct URL navigation before any `Meeting` row exists -> resolves parent `appointmentId` from occurrence ID, calls `provisionAppointmentMeeting()`, and redirects to `/meetings/<newMeetingId>`.
4. **INV-VIDEO-04 — Co-Presenter & Moderator Permission Safety (`lib/stream-video-role-ownership.ts`):**
   - Collaborators with role `CO_HOST`, `CO_INSTRUCTOR`, or `MODERATOR` are assigned Stream member role `co_presenter` (falling back gracefully to `call_member` if custom role is unconfigured in Stream dashboard).
   - `updateUserPermissions()` only passes valid Stream `OwnCapability` strings (`send-audio`, `send-video`, `screenshare`, `pin-call-track`, `mute-users`, `join-backstage`, `update-call-permissions`, `end-call`, `start-record-call`, `stop-record-call`) — never invalid strings that trigger Stream `400 Bad Request`.
5. **INV-CHAT-01 — Trial Session Chat Prohibition:**
   - For `appointmentsType === 'TRIAL'`, in-call chat (`MeetingRoom.tsx`) and persistent DM channels are strictly blocked on **both** client UI and server guards (`actions/stream/chat/channel.action.ts`).
6. **INV-CHAT-02 — Trusted Server Context & DPDP Consent Gate:**
   - All server-side background/webhook/cron upserts pass `{ serverTrusted: STREAM_SERVER_TRUSTED }` (`Symbol.for("familiarise.stream.serverTrusted")`).
   - Users lacking active `ConsentArtifact` (`STREAM_DATA_PROCESSING`) are fail-closed on Stream sync (`consent_required` / PII stripped).
7. **INV-SCHED-01 — Single-Active-Session Consultant Concurrency (`prisma/sql/check-constraints.sql`):**
   - Every confirmed (`isTentative = false`, non-tombstoned) `AppointmentOccurrence` across `CONSULTATION`, `SUBSCRIPTION`, `WEBINAR`, `CLASS`, and `TRIAL` requires `consultantProfileId IS NOT NULL` (`occurrence_confirmed_requires_consultant_chk`) and cannot overlap (`tstzrange("startsAt", "endsAt", '[)') WITH &&`) any other confirmed occurrence for the same `consultantProfileId` (`occurrence_no_confirmed_overlap`).
   - Owner transfer (`PATCH /api/appointments/[appointmentId]`) cascades `consultantProfileId` to non-terminal occurrences; class make-up (`POST /api/classes/[classId]/make-up`) maps PostgreSQL `23P01` to HTTP `409 Conflict`.

---

## §5. Primary Codebase Anchors

| Subsystem | Key Files |
| :--- | :--- |
| **Meeting Provisioning & Guards** | `actions/stream/meetings/meeting.action.ts`, `lib/meeting.ts`, `lib/meetings/call-settings.ts`, `lib/meetings/guard.ts`, `lib/meetings/room-ready.ts` |
| **Meeting API Routes** | `app/api/meetings/[meetingId]/{join,live,end,extend,recording,status,waitlist,session}/route.ts` |
| **Client Video Hooks & Room UI** | `hooks/useGetCallById.ts`, `hooks/useLazyJoinMeeting.ts`, `components/stream/video/MeetingRoom.tsx`, `components/stream/video/MeetingSetup.tsx`, `providers/StreamVideoProvider.tsx` |
| **Dashboard Join Adapters** | `app/dashboard/consultee/[consulteeId]/(features)/appointments/ConsulteeAppointmentsAdapter.tsx`, `app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter.tsx` |
| **Stream Chat Actions** | `actions/stream/chat/{user,channel,event-channel,dm}.action.ts`, `lib/stream/circuit-breaker.ts` |
| **Stream Webhooks** | `app/api/webhooks/stream/route.ts` |
| **DB Constraints & Scheduling** | `prisma/sql/check-constraints.sql`, `lib/scheduling/consultant-concurrency.ts`, `app/api/classes/[classId]/make-up/route.ts`, `app/api/appointments/[appointmentId]/route.ts` |
