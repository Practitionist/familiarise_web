# Gotchas in the compliance subsystem

Specific defects this subsystem has had, and the **class of mistake** each one
represents. Read before changing anything in `lib/compliance/`.

Each entry: what broke, why it was invisible, and the check that would catch it
next time.

---

## 1. A withdrawal could delete its own audit proof

**What broke.** `buildConsentArtifact` set `auditRetainedUntil = grantedAt + 7y`.
`withdrawConsent` never touched it, so the clock kept running from the _grant_.
An artifact granted six years ago and withdrawn today became deletable
immediately — and the retention sweeper would then delete the only record that
the user ever withdrew.

**Why it was invisible.** Nobody writes a test for "the audit trail must
survive". The defect is the _absence_ of a safety property, and the code looked
correct: it set a field, it just set the wrong one.

**The class.** A retention clock with more than one event that can advance it
needs a test per event, not per function.

**The check.** Withdraw at day 1; assert `auditRetainedUntil >= withdrawnAt + 7y`.

**Related.** The same field must be computed in **UTC**. `setFullYear()` reads
and writes in the host's local zone, so a DST transition inside the window
shifts the stored deadline by an hour — and the sweeper compares the value
directly, so a row can become eligible for deletion an hour early. Use
`setUTCFullYear`. And a test asserting `span > 7 * 365.25 days` is a
**date-dependent flake**: a 7-calendar-year window contains one or two leap days,
so the threshold holds only on some years and fails in others.

---

## 2. The admin erasure path never deleted the Novu subscriber

**What broke.** `DELETE /api/user/[id]` called `deleteSubscriber` on both
branches. The **operator** path — `POST /api/admin/erasure-requests/[id]/process`
→ `scrubUser` — never did. An erasure carried out by an admin left a live
mailing-list entry, holding the email and push tokens, for a user who had
explicitly asked to be erased.

**Why it was invisible.** There were two correct implementations of the same
rule. Coverage existed for one and the other was invisible, because the tests
targeted the _function_ rather than the _path_.

**The class.** A rule implemented at two call sites is one rule implemented
twice. Put it in the shared function.

**The check.** Grep every erasure entry point. A rule that must hold "on every
path" belongs inside the shared function, not beside it.

---

## 3. "Not configured" was indistinguishable from "deleted"

**What broke.** `deleteSubscriber` never throws and resolves `true` both when
the remote delete succeeded **and** when Novu is unconfigured. So a deployment
that lost `NOVU_KEY` reported a clean erasure while an earlier deployment's
subscriber still held the data — and the `vendorFailures` check saw `true` and
reported nothing wrong.

**Why it was invisible.** A two-valued return type is the defect. `boolean`
cannot express "confirmed" versus "unknown", so the caller had to guess, and
guessing optimistically is the dangerous direction.

**The class.** A helper whose return type cannot express a real outcome forces
every caller to invent a policy. Check whether the type is wide enough _before_
adding a caller.

**The check.** For every vendor helper: is the "we could not ask" case
distinguishable from the "we asked and it worked" case? If not, widen the type
or check configuration separately.

---

## 4. A failed vendor deletion could never be retried

**What broke.** `scrubUser` short-circuits when the user is already erased,
returning `vendorFailures: []`. The admin route `409`s on `COMPLETED`. So a
transient failure — a network blip, a briefly-wrong credential — was permanent:
re-running reported a clean success and the processor kept the data.

**Why it was invisible.** The idempotency guard was written to make repeated
calls cheap, and it was correct for the _local_ scrub. The vendor legs sit
outside the transaction, so "already done" was not true of them.

**The class.** Idempotency is per-side-effect, not per-function. A guard written
for the database is not automatically right for an external call.

**The check.** For every early return, ask what it skips. Does it skip anything
that is _not_ already durably done?

**Still open.** A process death between the transaction commit and the vendor
calls loses the obligation with no record that it was owed. The correct fix is a
durable outbox row written in the same transaction — `StreamRevocationRetry` is
the existing pattern in the same file.

---

## 5. Consent proof is destroyed on the hard-delete path

**What broke.** `ConsentArtifact.user` is `onDelete: Cascade`. A user with no
money history takes the hard-delete branch — a full FK cascade — which takes
the consent ledger with them. The soft path (`scrubUser`) correctly leaves it.

**Why it was invisible.** Two code paths implement "delete my account", both
correct in isolation, disagreeing on the one question an auditor asks.

**The class.** Two paths that implement the same user-facing action must be
compared property by property, not assumed equivalent.

**The check.** Diff what each path preserves. Anything load-bearing for
compliance is the interesting part of that diff.

---

## 6. `ConsentArtifact` cannot represent "not asked"

**What broke.** The model has only `grantedAt` / `withdrawnAt` /
`auditRetainedUntil` — no status enum. So "asked but unanswered", "never asked",
"declined" and "expired" are all unrepresentable, and the UI renders them all as
the same **"Not given"** badge. Three different follow-up actions collapse into
one.

**Why it was invisible.** The predicate `checkConsent` returns `false` for all
of them, so every _gate_ behaves correctly. Only the _UX_ and the _re-ask logic_
are wrong, and neither has a test that can fail.

**The class.** A fail-closed boolean hides missing states. The gate is right and
the model is wrong simultaneously.

**The check.** For every state you can distinguish in the requirements, confirm
the model can store it. And render the difference to a human.

---

## 7. `version` is written but never read

**What broke.** `ConsentArtifact.version` is only ever written as `1`, and
`checkConsent` **never reads it**. So shipping new notice text invalidates
nothing, and an artifact can carry stale wording indefinitely.

**Why it was invisible.** The field exists, is populated, and has a docblock
promising "Version increments when the notice text changes". It reads as done.

**The class.** A field that is written but never read is not a feature. Prove it
with a test that changes the version and asserts the gate moves.

**Related.** The `language` field has the same defect — write-only, always
`"en-IN"`, no gate consults it. Whether DPDP requires the notice in all 22
Schedule VIII languages is **unsettled**; see the claims register.

---

## 8. A backfill cron was documented and never built

**What broke.** `lib/auth.ts` claimed a "/consent backfill cron (#701)" would
re-create consent rows if the signup hook's stamp failed. That cron does not
exist. The hook fails open, so a failed stamp was **permanently unrecoverable**
— and the comment promised otherwise, which stopped anyone from noticing.

**Why it was invisible.** A comment asserting a compensating control reads
exactly like a compensating control.

**The class.** A comment promising a recovery path is a _claim_ about the
system. Verify it exists before relying on it, and do not restore the reference
until it does.

**The check.** `grep` for the claimed artefact. There are exactly four write
paths for `ConsentArtifact`: the auth hook, the org grant route, invite-accept,
and the seed.

---

## 9. Documentation that contradicts the code, in three places

**What broke.** The consent retention sweeper was described as "a daily cron"
that "purges rows" — in the module docblock, twice in the org consent
dashboard, and in the org consent route. It is **weekly**, and **count-only
unless `DPDP_SWEEPER_DELETE=true`**, in which case it deletes in capped batches.
In the default posture nothing is deleted at all.

The dashboard also told users retention runs "7 years from grant **or
withdrawal**" while the code ran it from the grant only.

**Why it was invisible.** Each copy was individually plausible, and no test
compares prose to behaviour. The user-facing one is the worst: a dashboard that
overstates both the cadence and the deletion is telling a user something untrue
about their own data.

**The class.** Duplicated facts drift. State the fact once and derive, or accept
that every copy needs checking.

**The check.** When a claim involves a schedule or an env-gated behaviour, read
the workflow file and the flag, not the doc that mentions it.
