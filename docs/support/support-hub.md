# Support & Feedback Hub

The `#support-hub` system (PR #1195): Swiggy-style, two-scope support built on
the channel-agnostic flowchart engine, plus the per-appointment CSAT feedback
rail. This document is the map of what exists, where, and the contracts that
hold it together.

## The two scopes, one engine

```text
lib/support/
├── flow-walk.ts          # PURE graph walk — both scopes execute identical transitions
├── flows.ts              # 10 appointment flowcharts (code-defined, PR-reviewed)
├── platform-flows.ts     # 5 stateless platform flows + reason→issueType taxonomy
├── priority.ts           # single reason→priority policy map
├── create-ticket.ts      # THE ticket factory + session-scope guard + dedup helpers
├── context.ts            # stage (UPCOMING/LIVE/COMPLETED), endsAt, isOrgOperator
├── service.ts            # runSupportTurn: reason/priority/org attribution,
│                         # lastMessageAt maintenance, ORG_PARTY_CATEGORIES
└── resolvers/            # flowchart-resolver (turn resolution over a flow)

lib/api/
├── support-http.ts       # the error envelope + Sentry policy + parseRouteParams
└── appointment-access.ts # ONE authz gate for appointment-scoped routes

lib/support/error-copy.ts # client-side code→friendly-copy mapper
```

### Per-appointment scope (persisted threads)

`AppointmentSupportThread` — one conversation per `(appointmentId, userId)`.
Intents are **stage-gated** like an order state: cancel/reschedule only while
upcoming; no-show/quality/recording only after completion. No-show has
attendee **and** provider variants. Terminals carry machine-readable
`reason`s (`provider_no_show`, `double_charge`, `quality_*`, …) that drive
priority and land in the ticket description on escalation.

- Route: `app/api/appointments/[appointmentId]/support/route.ts`
  (`GET` thread + server-gated intents, `POST` one turn)
- The sheet: `components/support/SupportThreadSheet.tsx`
- Status card: `components/support/AppointmentSupportStatusCard.tsx`

### Platform scope (stateless intake)

Platform issues (account, payments, site technical, operator billing) have no
appointment to hang a thread on. The flowchart runs **statelessly**: the
client holds the cursor and replays it each turn; the server validates every
transition against the registry and never trusts client state. A terminal
either self-serves (nothing written) or escalates — the only write, a
`SupportTicket` via the shared factory.

- Route: `app/api/support/platform/route.ts`
  (`GET` intent catalog for the caller's role, `POST` one turn)
- The sheet: `components/support/PlatformSupportSheet.tsx`
- Replay dedup: a terminal turn reuses the user's recent OPEN ticket for the
  same outcome (`findRecentOpenEscalation`, 30-minute window) instead of
  filing a twin.
- Org attribution: only on the `ORG_OPERATOR_BILLING` flow; an explicit
  `orgId` that isn't one of the caller's ACTIVE memberships is a 403, never a
  silent downgrade to a B2C ticket.

### The hub surfaces

| Surface | File | Scope |
|---|---|---|
| Consultee/consultant Support tab | `components/dashboard/shared/support/SupportHub.tsx` | Sessions subtab (recent-session picker + conversation buckets) + Platform subtab |
| Back-office inbox | `components/dashboard/shared/SupportThreadsPage.tsx` | `threads.manage` → full transcripts + reply + resolve/close |
| Org triage | `app/dashboard/organization/[orgId]/support/OrgSupportTriage.tsx` | `operations.read` → **metadata-only** thread list + CSAT aggregates (ADR 20) |
| CSAT card | `components/support/AppointmentCsatCard.tsx` | Private per-participant rating on completed sessions |

## The error envelope (the one contract)

Every support-surface error response is `{ error, code, detail? }`
(`lib/api/support-http.ts` → `supportError()`):

- `error` — USER-facing copy, safe to toast verbatim.
- `code` — machine discriminator (`UNAUTHORIZED`, `INVALID_ID`,
  `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`, `CONFLICT`,
  `INTERNAL`). Tests assert on it; dashboards group by it.
- `detail` — DEVELOPER material (zod flatten, ids). Echoed to the client only
  for client-fault statuses (<500); 5xx detail is Sentry-only.

**Sentry policy** (in `supportError`): an original exception is captured WITH
its stack (level `error` ≥500, `warning` below); a causeless 4xx is a
`captureMessage` warning (contract drift); **401/429 are expected client
noise and stay uncaptured on every path.** Exceptions are also
`console.error`'d so local dev without a Sentry DSN still sees them.

**Client mapping** (`lib/support/error-copy.ts`): `throwSupportError(res,
context)` logs the raw payload to the console and throws code-mapped friendly
copy; `describeSupportError(payload, fallback)` prefers code copy → server
`error` → fallback. Every hub consumer routes failures through these.

**Route params**: ids are opaque, length-bounded strings
(`schemas/support.ts` — `AppointmentIdParams`, `SupportThreadIdParams`,
`OrgIdParams`, all `min(1).max(64)`), never `.uuid()` — seeded demo databases
mint readable slugs (`demo0813-appt-ba`), and the DB lookup is the real
validator. `parseRouteParams(schema, params, ctx)` awaits the params promise
and answers the INVALID_ID envelope.

## Authz: one gate, org-party opt-in

`authorizeAppointment(appointmentId, orgParty?)`
(`lib/api/appointment-access.ts`) is the single participation gate for the
detail/feedback/support routes:

- Coded failures: `UNAUTHORIZED` → `NOT_FOUND` → `FORBIDDEN`.
- Participants and platform staff pass; success carries `organizationId` and
  the already-loaded `detail` (no second read).
- The **org-party grant is opt-in** (`orgParty: true`) and its success type
  carries NO `detail` — an org operator may open their OWN conversation on
  their org's appointment, org-party intents only
  (`ORG_PARTY_CATEGORIES`, defined once in `lib/support/service.ts` and
  clamped again defensively in `runSupportTurn`), and the full appointment
  graph is never reachable through the grant (ADR 20).
- Routes without an org-party surface (detail, feedback) call it bare; the
  type system then makes `isOrgParty: false` a fact, not a check to remember.

## Invariants worth knowing before you edit

1. **Status mirrors are transactional.** Thread ⇄ ticket status changes
   (`staff/support-threads/[threadId]` PATCH, ticket-route mirror) commit in
   one `prisma.$transaction`, CAS-guarded with `status: { notIn: ["CLOSED"] }`
   **unconditionally** — a status-conditional `notIn: []` is a no-op filter in
   Prisma and would clobber a closed thread.
2. **`resolvedAt` semantics**: RESOLVED stamps the clock, IN_PROGRESS clears
   it, CLOSED keeps it (closing a resolved thread must not erase its
   resolution time).
3. **`lastMessageAt` is the activity clock** on both `SupportTicket` and
   `AppointmentSupportThread` — every visible message write bumps it inside
   the same transaction (queue replies bump the ticket's clock too). The hub
   and both inboxes sort by it.
4. **The ticket spam budget is charged at escalation only** — navigating a
   flowchart must never spend the same budget as filing a ticket.
5. **The recording 48h window is server-verified** (`runSupportTurn`): a
   client claiming "within 48h" after the slot's `endsAt` + 48h has really
   passed is re-anchored onto the flow's escalation terminal. Claiming
   "beyond" early is allowed — wanting a human is never wrong.
6. **CSAT writes are participant-only** — staff read access must not become
   write access; a privileged non-participant's rating would pollute the org
   aggregate.
7. **CSAT aggregates suppress small cohorts** — `feedback-summary` returns
   `null` averages below `MIN_COHORT = 3` responses (an n=1 "average" is one
   member's exact rating; ADR 20).
8. **Org triage is metadata-only, by design** — the select allowlist is
   pinned by `__tests__/security/org-scope-payload-allowlist.test.ts`. Do not
   add content fields to `THREAD_METADATA_SELECT`.

## Schema (additive-only, freeze-compliant)

| Change | Why |
|---|---|
| `SupportTicket.organizationId?` + `@@index([organizationId, status])` | ops queue filterable by customer org |
| `lastMessageAt?` on `SupportTicket` + `AppointmentSupportThread` (+ `@@index([status, lastMessageAt])` on the thread) | "latest activity first" — `updatedAt` doesn't move on message inserts; the inbox sort needs the index |

> `@@index([status, lastMessageAt])` requires `npm run db:push` (which chains
> the sidecars) on each environment — a schema-only merge does not create it.

## Notifications (ADR 23)

Every support notification carries `NotificationScope` (attribution +
filing). Deep-links follow `lib/novu/resolve-href.ts` doctrine: org-hosted
threads link to `/dashboard/organization/<id>/appointments`; B2C stays a bare
`/dashboard` and the capability router picks the viewer's tree.

## Testing

- `__tests__/support/` — flow-walk (pure transitions), platform-flows (gates/
  taxonomy/priority), service (clamps, attribution, window verification),
  support-http (envelope + Sentry policy), error-copy (mapper),
  appointment-access (authz matrix incl. org-party metadata-only),
  appointment-support-route (**slug-id regression**: `demo0813-appt-ba` must
  200), platform-route (entry-turn regression, 404/401 envelopes).
- `__tests__/security/org-scope-payload-allowlist.test.ts` — pins the org
  triage select against content leakage.

## Deliberately out of scope

AI resolver, DB-stored flow editor, SLA timers, email intake, org admins as
notification *recipients* for member complaints, per-org Novu inbox, and
mirroring support chat into Stream (Postgres only — see the PR #1195
description for the reasoning).
