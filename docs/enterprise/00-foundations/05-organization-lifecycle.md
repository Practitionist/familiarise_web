# Organization lifecycle

Three models carry their own lifecycle state machine in the enterprise
layer: `Organization`, `Contract`, and `Program`. Each is driven by a
Prisma enum and guarded by explicit allowed-transition tables in the
API.

## `OrgStatus` state machine

```prisma
enum OrgStatus {
  PENDING_VERIFICATION
  ACTIVE
  SUSPENDED
  DEACTIVATED
}
```

```mermaid
stateDiagram-v2
  [*] --> PENDING_VERIFICATION: org created
  PENDING_VERIFICATION --> PENDING_VERIFICATION: REJECT (admin) / resubmit (OWNER·MAINTAINER)
  PENDING_VERIFICATION --> ACTIVE: VERIFY
  PENDING_VERIFICATION --> DEACTIVATED: DEACTIVATE
  ACTIVE --> SUSPENDED: SUSPEND
  SUSPENDED --> ACTIVE: REACTIVATE
  ACTIVE --> DEACTIVATED: DEACTIVATE
  SUSPENDED --> DEACTIVATED: DEACTIVATE
  DEACTIVATED --> [*]: terminal
```

Transitions are gated by `POST /api/admin/organizations/[orgId]/verify`
(`app/api/admin/organizations/[orgId]/verify/route.ts`). The route
accepts `action: VERIFY | REJECT | SUSPEND | REACTIVATE | DEACTIVATE`
(missing/`{}` defaults to `VERIFY` for legacy callers) and enforces:

| From                   | Allowed actions                   |
|------------------------|-----------------------------------|
| `PENDING_VERIFICATION` | `VERIFY`, `REJECT`, `DEACTIVATE`  |
| `ACTIVE`               | `SUSPEND`, `DEACTIVATE`           |
| `SUSPENDED`            | `REACTIVATE`, `DEACTIVATE`        |
| `DEACTIVATED`          | none — terminal                   |

Every transition emits an `OrgAuditLog` row in the `SYSTEM` category
with one of `AUDIT_ACTIONS.SYSTEM.{VERIFIED, SUSPENDED, REACTIVATED,
DEACTIVATED, VERIFICATION_RESUBMITTED}`.

### Verification reject → resubmit loop

`REJECT` is **not a status move** — it's a sub-state of
`PENDING_VERIFICATION` (#779 §A). The admin must supply a `reason`; the
route stamps `Organization.verificationReason` + `verificationRejectedAt`
and leaves `status = PENDING_VERIFICATION`. The OWNER/MAINTAINER then fixes
the issue and calls
`POST /api/organizations/[orgId]/verification/resubmit` (MAINTAINER+),
which only succeeds when the org is still `PENDING_VERIFICATION` **and**
`verificationRejectedAt` is non-null (otherwise `409 NOTHING_TO_RESUBMIT`).
Resubmit bumps `verificationSubmittedAt` and clears
`verificationReason` + `verificationRejectedAt`, so the admin queue picks
it up fresh. `VERIFY` clears the same sub-state on the way to `ACTIVE`.
There is **no** `RESUBMIT` enum value — the loop is carried entirely by
the three nullable timestamp/reason columns.

## What each status allows

- **PENDING_VERIFICATION** — the default on org creation. The org owner
  can configure settings, BillingAccount, invite members, and sketch
  contracts. `requireOrgAccess` still lets members in. Payments and
  payouts are not intended to flow until an admin flips the status to
  ACTIVE.
- **ACTIVE** — the only status where every feature is live.
- **SUSPENDED** — read-only guards are up to each caller; the org
  record is still accessible. The suspension reason is captured in the
  `OrgAuditLog.details.reason` field.
- **DEACTIVATED** — `requireOrgAccess` rejects every caller with a
  `403 "Organization has been deactivated"`. The row is retained for
  audit; admins use this instead of `DELETE` when the org has any
  contracts, invoices, POs, or earnings.

## Deletion

`DELETE /api/organizations/[orgId]` (`app/api/organizations/[orgId]/route.ts`)
is owner-only and refuses if the org has **any** of:

- `contracts` (any status)
- `invoices`
- `purchaseOrders`
- `earnings`

The error message tells the caller to use the admin deactivate path
instead. This is not a compliance rule — it's an audit-trail guarantee.

## Organization creation

`POST /api/organizations` (`app/api/organizations/route.ts`) runs a
single Prisma transaction that:

1. Validates a unique lower-case slug.
2. Creates the `Organization` with `status = PENDING_VERIFICATION`. The
   id is generated upfront (`randomUUID()`) so the `BillingAccount` can
   reference it in the same tx; the group-hierarchy columns
   (`parentOrganizationId` / `rootOrganizationId`) are left `null` —
   they're schema-only and inert in v1 (see
   [hierarchy](06-hierarchy.md)).
3. If `canSponsor=true`, creates the `BillingAccount` with the chosen
   `fundingSource`. `walletBalance = 0` is set when the source is
   `WALLET`, and `null` otherwise.
4. Creates an `OWNER` `Membership` row AND a matching BetterAuth `Member`
   row, bridged via `Membership.betterAuthMemberId`.
5. Upserts an `OrgWorkspaceProfile` for the creator (one row per user who
   operates an org, shared across multiple orgs) and stamps
   `User.orgWorkspaceProfileId`. The response body includes
   `orgWorkspaceProfileId` so the client can land the user on
   `/dashboard/org-workspace/:id/home` without a follow-up fetch.
6. Writes the first `OrgAuditLog` row (category `MEMBER`, action
   `MEMBER_ADDED`).

If `canSponsor || canHost` is false the request is rejected at the Zod
boundary.

### Wizard flow: commit-on-review

The UI wizard at `components/organization/create-wizard/` **defers the
POST to the final Review step's "Launch" action**. Earlier steps
accumulate state in local React state only — dropping out before
Review leaves zero rows in the database. This avoids orphan
`Organization` records from users who bail mid-setup.

```mermaid
sequenceDiagram
    participant U as User
    participant W as Wizard (client state)
    participant API as POST /api/organizations
    participant R as ReviewStep

    U->>W: Fill Org Info (name, capability, email)
    Note over W: state only — no API call
    U->>W: Fill Billing / Revenue Rates
    Note over W: state only — no API call
    U->>W: Fill Branding / Invites
    Note over W: state only — no API call
    U->>R: Review + edit pass
    U->>R: Launch Organization
    R->>API: POST / (create + BillingAccount + OWNER)
    API-->>R: { organization: {...} }
    opt Branding / rate-card fields
        R->>API: PATCH /[orgId] (colors, bps)
    end
    opt Invitees staged
        R->>API: POST /[orgId]/invitations (parallel)
    end
    R->>U: Redirect /dashboard/organization/[orgId]/home
```

If `Launch` fails after the POST succeeded but before the PATCH or
invites land, the wizard keeps `initialData.orgId` in state so the
retry hits the same org row — the POST path is short-circuited and the
retry is fully idempotent.

## `Contract` lifecycle

```prisma
enum ContractStatus {
  DRAFT
  ACTIVE
  EXPIRED
  TERMINATED
}
```

This doc is the state-machine **overview**. The deep contract mechanics
(supersession terms math, lock fields, cron internals) live in
[contract-lifecycle](../30-programs-and-lifecycle/07-contract-lifecycle.md).

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> ACTIVE: sign (signedAt)
  DRAFT --> [*]: delete (DRAFT only)
  ACTIVE --> EXPIRED: effectiveTo passes (cron) / RENEWAL supersede
  ACTIVE --> TERMINATED: OWNER end-early / AMENDMENT supersede
  ACTIVE --> ACTIVE: autoRenew cron mints successor (this row → EXPIRED)
  EXPIRED --> [*]
  TERMINATED --> [*]
```

- `DRAFT` → `ACTIVE` via `PATCH /api/organizations/[orgId]/contracts/[contractId]`
  (OWNER only). The handler sets `signedAt = now()` and flips the status.
  `autoRenew` is a safe forward-looking toggle and stays editable on an
  ACTIVE contract; the money/term fields (`effectiveFrom/To`,
  `paymentTermsDays`, `rateCardId`, `billingAccountId`) lock once the
  contract leaves DRAFT or starts billing (`LOCKED_CONTRACT_FIELDS` in
  `lib/enterprise/config-lock.ts`).
- `ACTIVE` → `EXPIRED` when `effectiveTo` passes, set by the
  `jobs/contracts/expire-contracts.ts` cron
  (`.github/workflows/expire-contracts.yml`). Earnings already snapshot
  their `rateCardId` + bps so in-flight settlement isn't affected.
- `ACTIVE` → `TERMINATED` is an OWNER-initiated **end-early** (PATCH
  `status=TERMINATED`). Programs attached to a terminated/expired contract
  can't accept new bookings (`POST /programs` refuses to attach to a
  TERMINATED/EXPIRED contract).

**Auto-renew.** When `autoRenew=true` and `effectiveTo` passes, the
`jobs/contracts/auto-renew-contracts.ts` cron
(`.github/workflows/auto-renew-contracts.yml`) renews instead of letting
expiry run: it claims the row by stamping `autoRenewedAt` (the claim
doubles as a distributed lock — idempotent across replicas), mints a
`RENEWAL` successor (same org / billing account / terms, fresh period),
and flips the old row to `EXPIRED` with the supersession chain set. So an
auto-renewing contract never reaches `expire-contracts` with anything left
to do.

**Supersession chain.** Contracts are immutable once in use, so changing
terms means minting a successor and retiring the old row, recorded via:

- `supersededByContractId` (`@unique`) — old row points forward to the new
- `supersededAt` — when the chain was cut
- `supersessionReason: AMENDMENT | RENEWAL | TERMINATION_REPLACEMENT`

`POST /api/organizations/[orgId]/contracts/[contractId]/supersede` (OWNER)
mints the successor and re-points the programs onto it (so the cycle engine
keeps rolling their assignments), while invoices stay on the old
contract — the money trail rides the term that billed it. The route accepts
`reason: AMENDMENT | RENEWAL`: AMENDMENT cuts over now and retires the old
row → `TERMINATED`; RENEWAL chains off the old `effectiveTo` and retires it
→ `EXPIRED`. `TERMINATION_REPLACEMENT` is enum-reserved but not yet a
supersede-route option. The `@unique` on `supersededByContractId` is the
double-run backstop. Full term-math: see
[contract-lifecycle](../30-programs-and-lifecycle/07-contract-lifecycle.md).

**EXPIRED / TERMINATED cascade.** Retiring a contract (whether via the cron
or an end-early PATCH) takes its dependents down **in the same
transaction**, so nothing is left drawing on a dead contract:

- the contract's `ACTIVE` programs → `EXPIRED`
- their still-`ACTIVE` assignments → `CLOSED` (the cron also pins
  `periodEnd = now`)

`DELETE /api/organizations/[orgId]/contracts/[contractId]` is only
permitted on `DRAFT` contracts; anything else must transition to
`TERMINATED`.

Each transition emits an `OrgAuditLog` entry in the `CONTRACT` category
via `AUDIT_ACTIONS.CONTRACT.{CONTRACT_CREATED, CONTRACT_SIGNED,
CONTRACT_TERMINATED, CONTRACT_EXPIRED, CONTRACT_SUPERSEDED}`.

## `Program` lifecycle

```prisma
enum ProgramStatus {
  ACTIVE
  PAUSED
  EXPIRED
  CANCELLED
}
```

```mermaid
stateDiagram-v2
  [*] --> ACTIVE
  ACTIVE --> PAUSED: pause (no new assignments/bookings)
  PAUSED --> ACTIVE: resume
  ACTIVE --> EXPIRED: contract effectiveTo passes (cron)
  ACTIVE --> CANCELLED: delete (no assignments) / terminal
  PAUSED --> CANCELLED
  EXPIRED --> [*]
  CANCELLED --> [*]
```

- `PAUSED` stops new `ProgramAssignment`s and new bookings against
  existing assignments. Existing sessions already in-flight are not
  cancelled.
- `EXPIRED` is driven by the contract `effectiveTo` cascade — the
  `expire-contracts` / `auto-renew-contracts` crons flip ACTIVE programs
  to EXPIRED in the same transaction that retires the contract (see the
  Contract section above).
- `CANCELLED` is a terminal state set by
  `DELETE /api/organizations/[orgId]/programs/[programId]` (MAINTAINER)
  when there are no assignments. If assignments exist, the route flips
  to `CANCELLED` status rather than hard-deleting.

A program with `configLockedAt` set is never hard-deleted (financial
history rides on it); `archivedAt` is the soft-delete that hides it from
active lists. See [funding-and-programs](03-funding-and-programs.md).

`POST /api/organizations/[orgId]/programs/[programId]/assignments`
only accepts assignments when `program.status = ACTIVE`.

## `AssignmentStatus` lifecycle (summary)

Each `ProgramAssignment` carries its own status (#779 §A — previously
inferred from `periodEnd` vs now). At a glance:

```prisma
enum AssignmentStatus {
  ACTIVE
  ROLLED
  PAUSED
  CLOSED
  CANCELLED
}
```

```mermaid
stateDiagram-v2
  [*] --> ACTIVE: assignment created (stamps Program.configLockedAt on first)
  ACTIVE --> ROLLED: cycle advanced — successor minted
  ACTIVE --> PAUSED: org-suspend cascade froze it
  PAUSED --> ACTIVE: org reactivated
  ACTIVE --> CLOSED: governing contract expired / terminated
  ACTIVE --> CANCELLED: member removed mid-cycle
  ROLLED --> [*]
  CLOSED --> [*]
  CANCELLED --> [*]
```

- `ROLLED` — the nightly cycle engine advanced the period: it minted a
  fresh `ACTIVE` successor (zeroed `engagementsUsed`/`consumedPaise`) and
  pointed the closing row at it via `rolledToAssignmentId` (`@unique`) +
  `rolledAt` (the idempotency gate).
- `CLOSED` — the contract went `EXPIRED`/`TERMINATED` and the cascade
  closed the assignment (no successor).
- `PAUSED` / `CANCELLED` — org-suspension freeze and mid-cycle member
  removal, respectively.

The roll-vs-close decision, period math, and rollover chain are detailed in
[cycle-engine-and-rollover](../30-programs-and-lifecycle/08-cycle-engine-and-rollover.md)
(`lib/enterprise/cycle-engine.ts` + `jobs/billing/advance-program-cycles.ts`).

## Related docs

- `organization-types` — capability flips also gate status
  mutations (can't disable canSponsor with a non-zero wallet).
- `sso-and-authentication` — SSO enforcement for
  PENDING_VERIFICATION orgs.
- `programs` — the program subtypes behind this lifecycle.
