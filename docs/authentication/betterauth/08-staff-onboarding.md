# Staff onboarding

| Field | Value |
|---|---|
| Status | Implemented (#1927) — this document states the contract, not the code |
| Audience | All engineers |
| Last reviewed | 2026-09-29 |
| Source files | `scripts/bootstrap-admin.ts`, `lib/auth/staff-invitations.ts`, `app/api/auth/staff-invitation/accept/route.ts`, `app/api/admin/staff-invitations/`, `lib/auth-helpers.ts`, `lib/auth/backoffice-permissions.ts`, `prisma/schema.prisma` (`StaffInvitation`) |

> **This document states the contract and the invariants, not the
> implementation.** It is written so the argument survives a refactor. Every
> specific symbol is marked `<!-- verify: agent-owned -->`, so a reconciliation
> pass knows which names to check against the merged branch and which claims are
> load-bearing doctrine that should survive verbatim even if a name changes.

## 1. Background

There is exactly one `ADMIN` on this platform today, and `STAFF` is a handful of
people. That is unusual for a company with enterprise tenants, an audit
obligation and a DPDP surface, and it is the reason the back-office matrix puts
irreversible actions on the account that answers for them.

It is also why "how does a new admin get created" could not be a self-service
flow, and why it was not one at all until #1927. Before it, `UserRole.ADMIN` and
`UserRole.STAFF` were hard-rejected from self-service onboarding, the only
`role: STAFF` write site required an *existing* ADMIN, and the production
admins that did exist were `prisma/seed.ts` faker rows with a `SeedPass123!`
default — a password printed in a README. The front door that was missing is
now a script, and the invariants below are why it is a script and not a route.

## 2. Scope

| In scope | Out of scope |
|---|---|
| Bootstrapping the first `ADMIN` | Which surfaces each role reaches — see [`docs/authorization/`](../../authorization/README.md) |
| Minting, redeeming and revoking a staff invitation | Org invitations — a different model, a different audience, a 14-day TTL |
| The mandatory-2FA precondition on privileged surfaces | The 2FA mechanisms themselves (`totp`, emailed OTP, backup codes) |
| The impersonation deny-list | |

## 3. Where to start

| # | Section | Reading time |
|---|---|---|
| 1 | [Why domain is not the authorisation key](#4-why-domain-is-never-the-authorisation-key) | 3 min |
| 2 | [The bootstrap chain](#5-the-bootstrap-chain) | 4 min |
| 3 | [The token contract](#6-the-token-contract) | 5 min |
| 4 | [What the token authorises, precisely](#7-what-the-token-authorises-precisely) | 4 min |
| 5 | [Two-factor](#8-two-factor) | 6 min |
| 6 | [Impersonation](#9-impersonation) | 3 min |

## 4. Why domain is never the authorisation key

The obvious design for "who is staff" is an email-domain allowlist, because the
company has a domain and everyone works there. It is wrong here, and the reason
is a product fact rather than a technical one.

**Staff addresses are a mix of personal `@gmail.com` and
`@familiarisenow.com`.** A domain check would lock out half the team, and — the
worse half — it would *look* like a control while being only a convention.

The actual authorisation is: *an existing `ADMIN` caused this row to exist, and
the holder of this address redeemed the token.* Nothing about the address's
right-hand side adds to that. So there is no domain branch in
`lib/auth/staff-invitations.ts`, and there must never be one: the checks a
future maintainer will be tempted to add — `endsWith("@familiarisenow.com")`, a
`TRUSTED_STAFF_DOMAINS` env var, a JIT-by-domain auto-provision — are three
spellings of the same wrong idea.

Revocation is per-**user** for the same reason. There is no "revoke the company
domain".

> Domain-enforced SSO still exists, for **customers**, in `SsoProvider` /
> `lib/sso/**`. It is a different feature, and this flow must not grow a line of
> it. The two vocabularies must not be confused:

| Claim | Key | Proof |
|---|---|---|
| *This person is staff* | an explicit `User.role` | a row minted by an existing `ADMIN`, redeemed by the addressee |
| *This domain is a tenant* | `OrgDomainClaim` | DNS-TXT at `_familiarise-verify.<domain>` |
| *This address signs in via SSO* | `OrganizationSSOSettings.allowedEmailDomains` | the same verified claim |

**An address is an identifier. A role is a grant.** Nothing in this flow infers
one from the other.

## 5. The bootstrap chain

Three operations, and they are deliberately not the same thing.

### 5.1 The first admin

<!-- verify: agent-owned -->
[`scripts/bootstrap-admin.ts`](../../../scripts/bootstrap-admin.ts) is the front
door. It creates a `StaffInvitation` row and either mails the setup link or
prints it. It is not a route, it has no admin to authorise it, and it is not
self-service.

**It never writes a password.** Not a generated one, not a default one, not a
hashed one. The password is chosen by the person who opens the link, which means
it is never in a shell history, a CI log, a deploy transcript, or a password
manager belonging to someone who is not the account holder. That is the entire
reason this is a script and not a `--password` flag.

**The second admin is prevented by a transactional check, not by a flag.**
<!-- verify: agent-owned — `assertNoAdminExists` in `scripts/bootstrap-admin.ts` -->
The guard is `assertNoAdminExists`, which reads inside the same transaction that
would write the row. `--force` exists, and the distinction matters: a flag is a
decision an operator makes, a transaction is a fact the database establishes.
Two operators running the script at the same moment on a fresh deployment both
pass a pre-flight check, and only the transaction can say no to one of them.

Idempotency is part of the contract, not an afterthought:

| Starting state | Behaviour |
|---|---|
| No admin, no pending invite for the address | create the row, send (or print) the link |
| Pending invite for the address | no-op, report the existing state. With `--print` it re-prints **nothing** — the raw token is unrecoverable by design — and says so |
| An account already exists for the address | refusal |
| An admin already exists at all | refusal unless `--force` |

### 5.2 Every admin after that

<!-- verify: agent-owned — `app/api/admin/staff-invitations/route.ts` (POST), `[invitationId]/route.ts` (PATCH) -->
An existing `ADMIN` mints a `StaffInvitation` for a `STAFF` or `ADMIN`
recipient. The invitation is a **separate** model from the org `Invitation` —
own table, own status enum, own TTL — because a staff token is worth
`refunds.manage` and an org token is worth a seat.

`role` is a **column**, not a constant. `STAFF` is the only value the UI mints
today (`INVITABLE_STAFF_ROLES`), but the bootstrap and any future operator tier
are a *data* change rather than a migration, and typing the column as `UserRole`
means a bad promotion fails at the enum rather than at a sign-in.

<!-- verify: agent-owned — `team.read` in `lib/auth/backoffice-permissions.ts` -->
The roster is its own back-office surface, `team.read`, split from `users.read`
deliberately. "Who else is on staff" is a normal ticket; a roster that lists
every operator's 2FA state, last login and live session count is reconnaissance
for the door that suspends them. The **mutations** — invite, revoke, suspend,
reactivate, force sign-out — deliberately reuse `users.moderate` rather than a
`team.manage` key, because they are exactly "role change / delete someone's
access", and a second key for the same act is a second place to get the policy
wrong.

### 5.3 Promotion never carries another person's password

No actor — not an admin, not a support agent, not a script — may set or reset
another person's password as part of granting a role. A support agent who can
mint a password for a named account can take it over, and the audit trail
records their own name on the impersonation.

Resetting a password is a *mail the person a single-use link* operation
(`POST /api/auth/request-password-reset`), subject to the same
`auth.password-reset-request` budget as any other caller. It is deliberately
not a back-office surface: `users.moderate` — the irreversible user actions — is
ADMIN-only, and even an ADMIN's path is "ban, role change, force sign-out", not
"choose a password".

## 6. The token contract

A setup token is a bearer credential that mints a role, so it is held to the
reset-token bar and not the invitation bar. Five properties, all load-bearing.

| # | Property | How | Why |
|---|---|---|---|
| 1 | **Bound to one email address** | `StaffInvitation.email` is a column, normalised by `normalizeStaffEmail` at write time and again by a partial unique index on `lower(email)` | The request body carries no `email` at all (§7), so there is nothing to compare — the binding is structural. A forwarded link cannot be redirected. |
| 2 | **Single use** | `claimStaffInvitation` CASes `status = PENDING → ACCEPTED`; a `count === 0` is the loser's answer | Two concurrent accepts from one link both pass every check, and only the database can decide which proceeds. The loser gets `SETUP_TOKEN_ALREADY_USED`, which is the truth from its side. |
| 3 | **Expiring** | `STAFF_INVITATION_TTL_MS` = 72 hours | Deliberately shorter than the org invite's 14 days. This is a platform-privileged account: 72 h is long enough to notice the mail and short enough that a link sitting in a shared inbox has a small window. |
| 4 | **Revocable** | `StaffInvitationStatus.REVOKED` → `INVITATION_REVOKED`; the row stays so the Team page can show *revoked by whom, when* | A token issued in error must be killable without waiting out the TTL, and a silently-dropped row is an unauditable deletion. |
| 5 | **Not stored in plaintext** | `tokenHash` is SHA-256 hex of 32 CSPRNG bytes; the raw token exists only in the email body and the operator's terminal | A `staff_invitations` table is a list of valid role-minting credentials. |

Two of those choices need their reasoning recorded, because both look like
downgrades.

**SHA-256, not bcrypt.** The token is 256 bits of CSPRNG output. There is no
dictionary to slow down, so a password-strength hash would add latency to an
accept path that has to stay inside Netlify's 60-second function budget and buy
nothing. The comparison is `timingSafeEqual` over equal-length hex digests.

**Four statuses, not two.** `PENDING | ACCEPTED | REVOKED | EXPIRED`, and the
distinction is load-bearing in the sentences. A revoked invitation and a spent
one are different conversations with the person holding the link, and `EXPIRED`
is kept apart from `REVOKED` because **nobody chose it**. Status is read *after*
the row, never in the `WHERE`, precisely so each terminal state can have its own
code.

One ordering rule inside the lookup: an `ACCEPTED` invitation past its expiry is
`SETUP_TOKEN_ALREADY_USED`, **not** `SETUP_TOKEN_EXPIRED`. The person already
has the account; telling them the link expired sends them to ask for another
they do not need.

### The codes

<!-- verify: agent-owned — `StaffInvitationRefusalCode` in `lib/auth/staff-invitations.ts` -->
Four codes, all already in the catalog, all carrying `action: "contact-support"`:

| Code | Title | Read when |
|---|---|---|
| `SETUP_TOKEN_INVALID` | "This setup link isn't valid" | unknown token, or one that no longer maps to a row |
| `SETUP_TOKEN_EXPIRED` | "This setup link has expired" | past 72 hours and not yet accepted |
| `SETUP_TOKEN_ALREADY_USED` | "This setup link was already used" | already redeemed, or lost the CAS race — and the copy adds *"If that wasn't you, contact support — your account may be at risk"*, because a replay attempt is an incident, not a typo |
| `INVITATION_REVOKED` | see the catalog | an admin pulled it |

`contact-support` rather than `retry` is deliberate and is the one place in the
auth catalog where a dead end is the correct answer. A staff member who cannot
complete setup has a *support* problem: the token's fate is known, and retrying
cannot help.

## 7. What the token authorises, precisely

<!-- verify: agent-owned — `app/api/auth/staff-invitation/accept/route.ts` -->
Exactly one thing: **"create a `User` with THIS email, THIS role, and a password
the holder chooses."**

The request body carries a token and a password and **nothing else** — no
`email`, no `role`, no `name` the caller could assert. An attacker holding a
leaked link therefore cannot redirect the account to their own address, cannot
promote it to `ADMIN`, and cannot create a second account with it. This is
strictly stronger than the org invite-accept precedent, where the claim is bound
by comparing two addresses; here the address is a column on the row.

Two consequences that are easy to get wrong on review:

**`emailVerified: true` is not a skipped verification step.** The usual reason to
require `verify-email` is that the platform cannot otherwise show the address
belongs to its owner. Here it can, in the strongest available way: a human with
platform authority caused a row addressed to this exact address, and the
redeemer proved control of it by reading a token that was only ever delivered
there.

**The accept flow does not mint a session.** Redeeming the link creates the
account; signing in is a separate act. A replay must be a `410`-shaped refusal
(`SETUP_TOKEN_ALREADY_USED`), and an auto-sign-in would turn a leaked link into
a live session rather than a closed door.

**An admin never chooses another person's password**, and the schema for the
request has no field that would let one. The invitee sets their own. An admin
who could choose or seed one could log in as that person forever, with no
session, no further action and no trace — and an admin who *can* seed a password
will eventually seed one they know, "to save a support call".

## 8. Two-factor

### The rule

<!-- verify: agent-owned — the shared guard body in `lib/auth-helpers.ts` -->
A `USER.role` of `ADMIN` or `STAFF` may not use a privileged surface without a
satisfied second factor. The refusal is `TWO_FACTOR_REQUIRED` — *"Set up
two-factor authentication. Staff accounts need a second factor before you can
continue"* — answered as **HTTP 428** with an `X-Auth-Action: enroll-2fa`
header.

428 rather than 403 is the point. A 403 tells a client the door is shut forever
and sends an operator to support; 428 plus the action header sends them to the
enrolment page the catalog's `action` already names. The impersonation check
runs first (it decides from the session alone; the 2FA check does not), and the
order is not arbitrary.

### Why the guard and not session creation

This is the decision people get wrong, and the answer is a deadlock.

The alternative is to make Better Auth hard-fail session creation for a staff
user without 2FA. That is strictly worse, because it locks the user out of the
**very page they need to enrol on**. An admin who signs in, is refused at
session creation, has no session, therefore cannot reach Settings, therefore can
never satisfy the condition — a bootstrap deadlock with no operator escape except
a database write.

The guard shape inverts it: the session exists, the *surface* refuses, and the
refusal names the next step.

### The exemption list is the load-bearing part

<!-- verify: agent-owned — `TWO_FACTOR_EXEMPT_PATHS` / `isTwoFactorExemptPath` in `lib/auth-helpers.ts` -->
`TWO_FACTOR_EXEMPT_PATHS` is enumerated exhaustively, with an owner per entry,
because the failure mode of getting it wrong is silent and total: the gate
refuses a staff session, the refusal points at `enroll-2fa`, and the target is
unreachable — so **nobody can ever hold a privileged account again**. That is a
self-inflicted permanent outage introduced by a security change, which is the
worst possible time to find it.

| Exempt | Why |
|---|---|
| All eight BetterAuth two-factor endpoints (`enable`, `verify-totp`, `verify-otp`, `verify-backup-code`, `send-otp`, `generate-backup-codes`, `get-totp-uri`, `disable`) | `enable` and the verifications are the enrolment; the rest are recovery, and a locked-out operator must be able to rotate them |
| `/dashboard/admin/settings`, `/dashboard/staff/settings` | Where the enrolment UI mounts. Two entries because the back-office tree is addressed by tree segment and the staff tree has to reach it too |
| `/auth/setup-admin`, `/auth/staff-invite` | Not privileged routes at all — an operator arriving from a setup link has no 2FA *and* no session. Listed so a future widening of the gate to "any authenticated user" cannot catch the one screen a brand-new operator is shown |

Three things are **deliberately not exempt**, and each is a decision:

- **`/dashboard/{admin,staff}/**`.** An unenrolled admin sees a 428 from every
  API, not a console. That is the intended answer.
- **`app/api/admin/staff-invitations`.** Inviting the *second* admin. It is not
  exempt because the first admin can reach `/dashboard/admin/settings` and
  enrol first; exempting the door that mints privileged accounts from the very
  control that makes an account privileged would hand the gate its own bypass.
- **The BetterAuth two-factor endpoints are served by `app/api/auth/[...all]/route.ts`**
  and never reach the helpers in `lib/auth-helpers.ts`. That is exactly why the
  list is *checked* rather than merely documented: today it is the thing that
  guarantees that the day someone moves this gate into middleware, the
  enrolment endpoints are not caught by it.

An exemption is a **reviewed code change**, not a configuration value:
`OperatorGateOptions.twoFactorExempt` has no env-var path, and a route that sets
it must say in a comment which entry of `TWO_FACTOR_EXEMPT_PATHS` it is.

### Configuration the flow inherits

`lib/auth.ts` configures `twoFactor({ allowPasswordless: true, … })`. That flag
is not optional and its reason is not obvious: the plugin refuses to enable 2FA
for a user with no credential account, and this app has real users who sign in
only through Google, GitHub or enterprise SSO. Without `allowPasswordless`,
those accounts could not secure themselves at all.

`twoFactorCookieMaxAge: 600` is the plugin default and is right for the same
reason it is right for everyone else: long enough to fetch an authenticator,
short enough that a shoulder-surfed six-digit code is not worth waiting for.
`storeOTP: "hashed"` is the only acceptable storage for a code that is valid for
minutes and readable by anyone with Redis access, and
`storeBackupCodes: "encrypted"` for the ten single-use backup codes.

**These plugin flags decide which sign-in methods are *challenged*, and they do
not decide who *must* have 2FA.** That is a server-side policy question and it
is answered by the guard, not by the plugin. Keeping the two apart is what lets
a consumer's 2FA stay voluntary and a staff member's stay mandatory from the same
configuration.

### One coupling worth knowing about

<!-- verify: agent-owned — `STAFF_PASSWORD_BCRYPT_ROUNDS` in `lib/auth/staff-invitations.ts` -->
`STAFF_PASSWORD_BCRYPT_ROUNDS = 12` **must** equal the `bcrypt.hash(password,
12)` in `lib/auth.ts`'s `emailAndPassword.password.hash`. bcrypt embeds the cost
in the digest, so a *lower* cost still verifies and a *higher* one would not —
which makes "we quietly used 10 here" invisible until it matters. The constant
is named and exported so it can be asserted in a test rather than eyeballed in
two files. `STAFF_PASSWORD_MIN_LENGTH` / `MAX_LENGTH` mirror
`minPasswordLength` / `maxPasswordLength` for the same reason.

## 9. Impersonation

<!-- verify: agent-owned — `IMPERSONATION_DENIED_SURFACES` in `lib/auth-helpers.ts` -->
Impersonation is a support tool, and it is denied on the surfaces where being
someone else would move money or destroy an account:

```
payments.manage · refunds.manage · disputes.manage · invoices.manage
subscriptions.manage · payouts.manage · approvalPayments.manage
classSeries.money · users.moderate
```

The list is **derived from the capability matrix** rather than enumerated as
routes, so it cannot drift as doors are added: a new money door arrives by
naming a money surface, and naming a money surface is what puts it here. The
read-only siblings (`refunds.read`, `payouts.read`, …) are deliberately absent —
the catalog's stated policy is that staff read every money surface so a billing
ticket is resolvable without an escalation, and blocking the read would break
the workflow impersonation exists to serve.

The refusal is `IMPERSONATION_BLOCKED` — *"Not allowed while viewing another
account. This action changes real money or data, so it can't be done on
someone's behalf. Sign back in as yourself."* — and it is evaluated **before**
the 2FA precondition, because it is a fact about the session rather than a
property of the operator.

## 10. Budgets

<!-- verify: agent-owned — `RATE_SCOPE.STAFF_INVITE_CREATE` / `AUTH_STAFF_INVITATION_ACCEPT` in `lib/rate-limit/policies.ts` -->
Two scopes, both in the policy table like every other auth surface:

| Scope | Keyed on | Why |
|---|---|---|
| `platform.staff-invite-create` | the minting `ADMIN` | An account-keyed budget on the operator, not the invitee, because that is the address the abuse lands on |
| `platform.staff-invitation-accept` | IP **and** the invitation token | The accept route is unauthenticated by necessity and carries a bearer credential worth `refunds.manage`; the token budget is what makes a leaked link provably useless quickly |

The second one is the reason this flow is a "policy route" and not a hand-written
`RateRule`. See
[`04-rate-limiting.md`](./04-rate-limiting.md#what-the-edge-can-and-cannot-enforce):
the accept token is in the request **body**, so the token budget is
handler-enforced and the edge spends only the IP dimension.

## 11. What this design survives

| Attack / failure | Why it fails |
|---|---|
| Anyone signing themselves an admin | Self-service onboarding hard-rejects `ADMIN` and `STAFF`; the only mint path is a script an operator runs, and a second admin needs an existing `ADMIN` |
| Two operators bootstrapping at once on a fresh deploy | `assertNoAdminExists` reads inside the write transaction. A flag would not settle it |
| A forwarded setup link | The address is a column on the row and the body carries no `email` |
| A replayed setup link | `claimStaffInvitation` CASes the status; the loser gets `SETUP_TOKEN_ALREADY_USED`, and the copy says to contact support because a replay is an incident |
| A leaked link promoted to `ADMIN` | The body carries no `role` |
| A link harvested from a shared mailbox | 72-hour TTL, revocable before that, and `sentCount` makes a resend loop visible |
| A `staff_invitations` dump minting roles | The table holds SHA-256 digests, not redeemable credentials |
| The bootstrap script leaking a password | It writes none. The token is printed once and is unrecoverable after that |
| An admin keylogging a new hire | The invitee sets their own password; the schema has no field for anyone else to |
| A staff member without 2FA reaching the money tables | The guard answers 428 + `X-Auth-Action: enroll-2fa` on every privileged surface, including the console |
| A privileged account permanently un-enrollable by a bad exemption | The list is checked, not documented, and the BetterAuth plugin routes are the reason it is checked today |
| An admin resetting a colleague's password to "help" | Not a back-office surface; the action list for `users.moderate` does not include it |
| An admin inviting a second admin to sidestep the 2FA gate | The invite route is not exempt, and the first admin can enrol first |
| Staff impersonating an admin to issue a refund | `refunds.manage` is in the deny-list, derived from the matrix so a new money door inherits the block |

## 12. Open items

| # | Item | Why it is open |
|---|---|---|
| 1 | Audit event naming for a platform role grant | The org side has `MEMBER_ROLE_CHANGED`; the platform side needs a name that cannot be confused with it, because a platform grant has no `Membership` row and no `orgId`. The roster's `revoked by <admin>, <when>` is currently read off the row, not off an audit entry |
| 2 | `revoke-and-reinvite` from the CLI | `scripts/bootstrap-admin.ts` refuses a re-run for an address that already has an account; there is no `revoke` flag, so recovery is via the Team page |
| 3 | `INVITABLE_STAFF_ROLES` vs the `role` column | The constant is `["STAFF", "ADMIN"]` and the column is `UserRole`. Nothing yet prevents a future tier from being invitable by accident, because the check lives in the route rather than in the model |
| 4 | A test asserting the exemption list against the real route tree | The list is checked against BetterAuth's plugin route list by hand and pinned by a comment; a walk of `app/api/**` would make the "no privileged door is unenrollable" claim structural |

## 13. Related docs

- [`../authorization/01-authorization-matrices.md`](../../authorization/01-authorization-matrices.md)
  — what `ADMIN` and `STAFF` may reach once granted, and why the back-office
  matrix exists rather than a rank comparison.
- [`04-errors.md`](./04-errors.md) — the catalog, the closed union, and why
  these codes had to exist before the code that mints them.
- [`04-rate-limiting.md`](./04-rate-limiting.md) — the two scopes this flow
  spends, and the declared-but-handler-enforced token budget.
- [`09-failure-modes.md`](./09-failure-modes.md) — what a user sees when Redis,
  Postgres or the platform is the thing that failed.
- [`lib/auth/backoffice-permissions.ts`](../../../lib/auth/backoffice-permissions.ts)
  — the surface matrix this flow grants entry to.
- [`prisma/schema.prisma`](../../../prisma/schema.prisma)
  — `StaffInvitation` and `StaffInvitationStatus`, whose per-column docblocks
  carry the reasoning this document condenses.
