# Deletion policy

This document defines when the codebase should **soft-delete** (flip a status flag) versus **hard-delete** (`prisma.x.delete()` / `deleteMany`). The current codebase already follows most of these rules; this doc captures the policy so new routes stay consistent.

## The one-line rule

**Default to soft-delete.** Hard-delete is reserved for four specific cases — everything else uses a typed status enum with a terminal value.

## Why soft-delete by default

1. **Audit trail preservation.** Compliance reviews ("did Wipro have access to Program X in Q2?") need historical truth. Hard-deleted rows can't answer the question.
2. **Reversibility.** Accidents happen — a misclick shouldn't require DB restore. Soft-delete lets an OWNER (or admin) restore by flipping status back.
3. **Foreign-key integrity.** `onDelete: Cascade` is seductive but dangerous — one accidental hard-delete on a high-fanout entity can erase dependent rows you didn't intend. Soft-delete keeps the row available to joins + downstream queries while marking it as inactive.
4. **Compliance retention.** Financial records (Payment, OrganizationInvoice, Refund, Earnings) must be retained for 5-7 years per Indian tax + accounting law. You cannot actually delete a paid invoice; the most you can do is a tax-void / tombstone.

## The soft-delete pattern

Every entity subject to soft-delete exposes a typed `status` enum with an explicit terminal value. Route handlers transition status; they never call `prisma.x.delete()`.

Concrete examples from the codebase:

| Entity | Status enum | Terminal values | Transition route |
|---|---|---|---|
| `Membership` | `MemberStatus` | `REMOVED` | `DELETE /api/organizations/[orgId]/members/[memberId]` flips to `REMOVED` |
| `Organization` | `OrgStatus` | `DEACTIVATED` | `POST /api/admin/organizations/[orgId]/verify` with `action=DEACTIVATE` |
| `Invitation` | (String) | `revoked`, `expired` | `DELETE /api/organizations/[orgId]/invitations/[invitationId]` → `revoked`; `cleanup-stale-invitations` cron → `expired` |
| `Contract` | `ContractStatus` | `TERMINATED`, `EXPIRED` | `PATCH /api/organizations/[orgId]/contracts/[contractId]` with status transition |
| `Program` | `ProgramStatus` | `CANCELLED`, `COMPLETED` | `DELETE /api/organizations/[orgId]/programs/[programId]` → soft cancel if assignments exist; hard-delete only if zero assignments |
| `OrganizationInvoice` | `OrgInvoiceStatus` | `VOID`, `CANCELLED`, `REFUNDED` | Status transitions via `PATCH` or webhook |
| `SsoProvider` | (via delete with guard) | row removed | hard-delete here is a known exception — see Case 4 below |

When you need to query "active rows only," filter by `status: { notIn: [/* terminal values */] }`. Active scope is enforced at the query site, not via Prisma middleware — explicit is better than magical.

## The four hard-delete cases

Hard-delete is only acceptable in one of these four cases.

### Case 1 — Ephemeral config rows with no audit value

Rows that exist purely as runtime state + have zero historical interest beyond their TTL window:

- **BetterAuth `Session` and `Account`** rows — deleted on logout or session expiry. No retention value.
- **Tentative `SlotOfAppointment`** rows — deleted when payment fails or the webhook rolls back an appointment (see `app/api/webhooks/utils.ts`, `lib/payments/webhooks/handlers.ts`).
- **Abandoned `WalletTopUp` rows** (PENDING / FAILED) past the grace window — reaped by `cleanup-abandoned-org-top-ups` cron. The unconfirmed row is schema-level noise; the fact that a top-up was abandoned is captured in the audit log + the cron's output. A *confirmed* top-up is never reaped — it owns a balanced `TOPUP` journal transaction (`LedgerEntry` rows are immutable, see Case 3).

### Case 2 — DRAFT-only entities with no commercial commitment

Rows that were created but never entered the commercial lifecycle:

- **`Contract`** in DRAFT — hard-delete only; ACTIVE / SIGNED contracts transition through `TERMINATED` / `EXPIRED` instead.
- **`OrganizationInvoice`** in DRAFT — hard-delete. Any invoice that was ever ISSUED must transition to `VOID` / `CANCELLED` / `REFUNDED`, never be deleted.

The route handler is responsible for the precondition check:

```ts
if (contract.status !== "DRAFT") {
  throw Object.assign(new Error("Only DRAFT contracts can be deleted"), { httpStatus: 409 });
}
await tx.contract.delete({ where: { id: contractId } });
```

### Case 3 — DPDP §12 right-to-erasure scrub

When a data subject exercises their §12 right under the DPDP Act 2023, the platform must erase their personal data within 30 days. Implementation is a **tombstone scrub**, not a row deletion:

- `User` row stays (financial records depend on it). Identifiable fields (`name`, `email`, `phoneNumber`, `image`) are overwritten with deterministic tombstones: `email = erased-<hash>@erased.invalid`, `name = ERASED_<hash>`.
- `ConsulteeProfile` / `ConsultantProfile` rows stay; free-text fields (`bio`, `linkedIn`) are nulled.
- `Membership` status flips to `ERASED` (new enum value, additive).
- BetterAuth `Session` / `Account` rows ARE hard-deleted (Case 1).
- `OrgAuditLog.details` JSON is scrubbed in-place for rows mentioning the erased user.
- Financial rows (Payment, Refund, OrganizationInvoice) and the
  double-entry journal (`LedgerTransaction` / `LedgerEntry`) are
  retained — legal retention supersedes erasure. `LedgerEntry` is
  immutable (`onDelete: Restrict` on both its transaction and account
  FK; reversals are explicit counter-transactions, never row edits or
  deletes), so erasure can only **pseudonymize the actor** — it never
  touches a money row. The tombstoned identity is enough to de-link.

**Status (PR #655, May 2026):** Phase 2 has landed. The manual log
`docs/compliance/erasure-requests-manual-log.md` is now read-only —
new requests flow through the API path below. Existing manual
entries remain for historical audit continuity.

#### Request lifecycle

1. User files via `POST /api/users/me/erasure-requests` (idempotent —
   re-filing while a PENDING request is open returns the existing row).
   `ErasureRequest.status = PENDING`.
2. Admin reviews via `GET /api/admin/erasure-requests` (queue surface).
3. Admin processes via `POST /api/admin/erasure-requests/[id]/process`
   (route flips status to IN_PROGRESS, runs `scrubUser`, marks COMPLETED).
4. OR admin rejects via `POST /api/admin/erasure-requests/[id]/reject`
   with a required `reason` (e.g. user has an open financial dispute).
5. 30-day SLA monitored externally — the request's `requestedAt` is the
   clock start; ops alerts when within 7 days of expiry.

#### What gets scrubbed (canonical reference)

The single source of truth is `lib/compliance/erasure/scrub-user.ts`.
Summary table:

| Field / Table | Action |
|---|---|
| `User.name` | `"Erased User <8-char hash>"` |
| `User.email` | `erased-<16-char hash>@erased.invalid` |
| `User.image, phone, address, bio, linkedinUrl, dateOfBirth` | NULL |
| `User.erasedAt` | `now()` |
| `User.pseudonymousId` | `sha256(userId + ERASURE_SALT)` |
| `Membership[].status` | `ERASED` |
| `ConsultantProfile.headline, videoIntroUrl` | NULL |
| `Session` + `Account` rows | hard-deleted (forces sign-out) |
| `Payment*`, `OrganizationInvoice`, `OrganizationPayout`, journal rows (`LedgerTransaction` / `LedgerEntry`) | **retained** (`LedgerEntry` is immutable, `onDelete: Restrict`) |

#### Cross-feature interactions

- **SCIM**: subsequent SCIM PUT/POST for an erased user returns
  `410 Gone` so the IdP marks the user as permanently un-provisionable.
- **Outbound webhooks**: a `member.removed` event fires per affected
  organization with `source: "dpdp_erasure"` so integrators see the
  deprovisioning even when the user was IdP-managed.
- **Audit log**: every processed erasure writes a
  `USER_ERASURE_PROCESSED` row to each affected org under the SYSTEM
  category. The audit row stays past the user's own erasure as the
  regulatory evidence-of-erasure record.

#### Recovery path

There isn't one. An erased user cannot be revived; if it turns out the
erasure was an admin error, the only path is to create a fresh
`User` (different email) and re-issue invitations. The pseudonymous id
on the original row is preserved for cross-reference investigations.

### Case 4 — Reversible config without audit value

Small configurational rows whose history lives in the audit log, not in the row itself:

- **`OrgDomainClaim`** — released via `DELETE /api/organizations/[orgId]/domain-claims/[domain]`. The release is captured as an `OrgAuditLog(SETTINGS / DOMAIN_RELEASED)` entry, so deleting the row loses no information. Anti-lockout guard refuses the delete if releasing would leave the org inconsistent (enforceSSO=true + zero providers + zero domains).
- **`SsoProvider`** — deleted via `DELETE /api/organizations/[orgId]/sso/providers/[providerId]`. Same reasoning: deletion captured as `SSO_DISABLED` audit row; anti-lockout guard prevents deleting the last provider when enforceSSO is on.

Both are OWNER-gated and guarded, so accidental deletion is unlikely.

## Decision tree

When adding a new route that removes something, walk this tree top-down. Stop at the first match.

```
1. Does the row carry historical / audit / compliance value?
     └─ YES → soft-delete. Add a terminal status value. Stop.

2. Does the row have FK dependencies from other preserved rows?
     └─ YES → soft-delete. Stop.

3. Is this a DPDP erasure scrub?
     └─ YES → see Case 3. Tombstone PII in place; retain financials. Stop.

4. Is the row purely ephemeral (session state, tentative placeholder)?
     └─ YES → hard-delete is OK (Case 1).

5. Is the row in DRAFT and has never entered the commercial lifecycle?
     └─ YES → hard-delete is OK with precondition check (Case 2).

6. Is the row reversible config whose history is audit-logged?
     └─ YES → hard-delete is OK with anti-lockout guards (Case 4).

7. Otherwise → soft-delete. If you genuinely think this is a new hard-delete
    case, document it here before writing the route.
```

## Current codebase audit

Routes that hard-delete are listed below. The ones marked `OK` match the policy above; the ones marked `REVIEW` are flagged for follow-up.

### Enterprise surface (`app/api/organizations/**`)

| Route | Entity | Action | Verdict |
|---|---|---|---|
| `DELETE /organizations/[orgId]/hris` | `HrisConfig` | hard-delete | OK — Case 4 (ephemeral config, OWNER-gated, audit log captures) |
| `DELETE /organizations/[orgId]/domain-claims/[domain]` | `OrgDomainClaim` | hard-delete | OK — Case 4 |
| `DELETE /organizations/[orgId]/sso/providers/[providerId]` | `SsoProvider` | hard-delete | OK — Case 4 |
| `DELETE /organizations/[orgId]/contracts/[contractId]` | `Contract` | hard-delete (DRAFT-only) | OK — Case 2 |
| `DELETE /organizations/[orgId]/programs/[programId]` | `Program` | soft / hard depending on assignments | OK — hybrid, correct policy |
| `DELETE /organizations/[orgId]/members/[memberId]` | `Membership` | soft (status=REMOVED) | OK — default soft-delete |
| `DELETE /organizations/[orgId]/invitations/[invitationId]` | `Invitation` | soft (status=revoked) | OK — default soft-delete |
| `DELETE /organizations/[orgId]` | `Organization` | hard-delete with reference check | REVIEW — see below |

**`DELETE /organizations/[orgId]` review**: this route hard-deletes an Organization only when zero references exist (no memberships, no invoices, no contracts, no programs). In practice any org that was ever ACTIVE has references, so the delete almost always fails — correct behavior. The policy-compliant alternative is to flip `status = DEACTIVATED` (already possible via `POST /admin/organizations/[orgId]/verify`). Recommend documenting this in the route header + deprecating the hard-delete path; track as follow-up issue.

### Non-enterprise surface (platform routes)

Out of this epic's scope but observed during the grep:

| Route | Entity | Action | Verdict |
|---|---|---|---|
| `DELETE /plans/webinars/[webinarPlanId]` | `WebinarPlan` | hard-delete | REVIEW — plans carry booking history; should be soft-delete via `isActive` flag |
| `DELETE /plans/classes/[classPlanId]` | `ClassPlan` | hard-delete | REVIEW — same |
| `DELETE /plans/consultations/[consultationPlanId]` | `ConsultationPlan` | hard-delete | REVIEW — same |
| `DELETE /plans/subscriptions/[subscriptionPlanId]` | `SubscriptionPlan` | hard-delete | REVIEW — same |
| `DELETE /user/[id]` | `User` | hard-delete | REVIEW — user hard-delete should be gated to DPDP §12 only; general self-delete should be soft |
| `DELETE /user/consultants/[id]` | `ConsultantProfile` | hard-delete | REVIEW — profiles are long-lived; soft-delete via `isActive` recommended |
| `DELETE /user/consultees/[id]` | `ConsulteeProfile` | hard-delete | REVIEW — same |
| `DELETE /events/webinars/[webinarId]` | `Webinar` | hard-delete | REVIEW — events have booking history |

**Follow-up work**: each REVIEW row above is a candidate for a small refactor PR. None are urgent for the enterprise launch — the routes work today, they just have a policy mismatch that will bite us later. Track under the `Enterprise` + `tech-debt` labels.

## Anti-lockout guards (v1)

Five vectors are guarded inside transactions; three more were closed in
the cleanup PR following the foundation work. The full list:

| # | Vector | Guard | Test |
|---|--------|-------|------|
| 1 | Demote the only ACTIVE OWNER | PATCH `/members/[memberId]` runs `count(role=OWNER, status=ACTIVE)` inside a Serializable transaction; refuses if the demotion leaves zero. | `__tests__/enterprise/member-anti-lockout.test.ts` |
| 2 | Remove the only ACTIVE OWNER | Same route, same guard — `status: REMOVED` is treated identically to a demote. | Same |
| 3 | Hard-delete the last verified domain claim on an `enforceSSO=true` org | Domain-claim `DELETE` rejects when the result would leave zero verified claims AND the org enforces SSO. | Manual (no unit test today) |
| 4 | Hard-delete the last `SsoProvider` on an `enforceSSO=true` org | SSO provider `DELETE` rejects when the result would leave zero registered providers AND the org enforces SSO. | Manual |
| 5 | Cascade-orphan an org via member soft-delete | All member removal goes through `status=REMOVED`, never raw `DELETE`. The soft-delete keeps audit + payment FKs intact. | Same as #1 |
| 6 | **Bulk member operations** | `/api/organizations/[orgId]/members/bulk` returns a deterministic `405` with `BULK_REMOVAL_NOT_SUPPORTED`. Closes the door on a future loop-bypass that skips the per-member Serializable guard. | `__tests__/enterprise/anti-lockout-gaps.test.ts` |
| 7 | **Terminate ACTIVE contract with live assignments** | Contract `PATCH status=TERMINATED` refuses when `programAssignment.count(periodEnd >= now)` > 0 on the contract's programs. Forces operator to cancel assignments (or wait for cycle roll) so checkout can't 500 on orphaned-assignment lookup. | Same |
| 8 | **Hard-delete program with utilization history** | Program `DELETE` runs at Serializable isolation, and refuses both when `_count.assignments > 0` *and* when any `BookingUtilization` row still references the program. The audit trail and refund path both rely on the FK target staying alive. | Same |

The two unguarded vectors (#9 contract concurrent termination, #10
batched program-config edits) are not user-exposed in the v1 UI and
are tracked under #703 §15 for v1.1.

## Glossary

- **Soft-delete** — row stays in the database; a status flag transitions to a terminal value that marks it as inactive. Queries filter on status.
- **Hard-delete** — `prisma.x.delete()` or `deleteMany()`; row is removed from the database.
- **Tombstone** — a soft-delete with PII fields overwritten by non-identifying placeholders. Used for DPDP §12 erasure to reconcile deletion-right with financial retention.
- **Cascade** — foreign-key `onDelete: Cascade` automatically deletes dependent rows when a parent row is deleted. Dangerous in production; prefer soft-delete at the parent level to preserve FK integrity without truncating children.

## Glossary — business terms

- **Design-partner customer set** (also informally "launch cohort") — the curated group of 2-3 enterprise customers onboarded during the first 3-6 months post-MVP to validate the enterprise tier. NOT related to the `Class` Prisma model (which is a B2C cohort-based course appointment type). The term appears in `52-design-partner-customer-set.md` where the selection criteria are spelled out.
