# Decision procedure — consent, withdrawal, erasure, terms

Start here for any of the four asks. Each branch ends with a concrete next
action and the evidence that must exist afterwards.

---

## A. The user changes or withdraws consent

```
Is this a NEW data purpose, or a withdrawal of an existing one?
├── New purpose ──► §A1
└── Withdrawal ───► §A2
```

### §A1 — A new data purpose is being added

**This is never carried by a ToS change.** It needs its own consent prompt,
its own record, and its own notice version.

1. **Add the purpose code** to `PURPOSE_CODES` in
   `lib/compliance/purpose-codes.ts` with a `PURPOSE_CODE_META` entry. That
   description is the itemised notice text — it is not decoration.
2. **Decide whether it is in `SIGNUP_PURPOSES`.** Almost certainly not. A new
   purpose is new consent, which means new users get prompted and **existing
   users get prompted too**.
3. **Write the notice.** DPDP s.5(1) requires it to accompany or precede the
   consent request; Rules 2025 r.3 requires it to be understandable
   independently of any other information.
4. **Add the gate call** at every point the purpose is actually used —
   `checkConsent({ userId, purposeCode })`, fail-closed. If the purpose is
   _optional_, degrade rather than error; if it is _load-bearing_, throw
   `ConsentRequiredError`.
5. **Bump the notice version.** Existing artifacts carry `version`, but
   `checkConsent` does **not** read it today — see
   `references/gotchas.md`. Until that is fixed, new copy silently invalidates
   nothing.
6. **Write the test**: no artifact ⇒ gate false; artifact ⇒ gate true; an
   artifact for a _different_ purpose must not satisfy it.

⚠ **Check the processor inventory.** A new purpose almost always means a new
processor or a new field set. That is an entry in the RoPA and a contract
question, not just a code change.

### §A2 — Withdrawal of an existing purpose

1. **`withdrawConsent({ userId, purposeCode })`.** Purpose-scoped by default —
   an omitted code withdraws everything, which the API route deliberately
   refuses to allow.
2. **Verify the clock restarted.** `withdrawConsent` must set
   `auditRetainedUntil` to now + 7y. If it does not, the retention sweeper can
   delete the proof of the withdrawal. This was a real defect; see
   `references/gotchas.md`.
3. **Cascade to the processors.** `withdrawConsent` handles Stream's sync
   cache. Anything else needs an explicit step. **Withdrawal is prospective
   only** — it stops future processing and does not delete data already
   collected.
4. **Record it.** The state change and the audit row in the **same
   transaction**. An asynchronous best-effort log is not evidence.
5. **Check whether the law imputes erasure.** PECR/ICO: yes. Bavarian DPA: no.
   CJEU C-129/21: scoped to the purpose. **Unsettled — resolve per purpose in
   writing.** See `docs/market-research/05-claims-register.md` §I1.
6. **Test**: gate flips false immediately; re-grant produces a **new** row and
   never mutates the withdrawn one.

---

## B. An erasure request arrives

### §B1 — Intake

- `POST /api/users/me/erasure-requests` is idempotent: an existing
  `PENDING`/`IN_PROGRESS` request short-circuits, backed by a partial unique
  index. Do not add a second path that can create a duplicate.
- The request must be satisfiable by a human later. It carries `reason` and
  flows to the admin queue.

### §B2 — The money-in-flight gate (do this first)

**Erasure is blocked while money is moving** for that identity: pending or
processing payouts, unsettled earnings, open disputes, or an issued/overdue
invoice on an org they solely own.

This is a **correctness** requirement, not a compliance one. Failing a
settlement in flight is unrecoverable. Return a typed 409 with the counts so
the operator can see what to settle.

### §B3 — Local scrub

`scrubUser(prisma, userId)`:

- Rewrites the user row to a pseudonym (`erased-<hash>@erased.invalid`,
  `name → "Erased User <8hex>"`).
- Nulls PII on profiles, payout-account masked fields, and user-authored text.
- Flips memberships, program assignments and collaborators.
- Hard-deletes sessions and accounts — immediate sign-out everywhere.
- **Deliberately preserves** `city`/`country` (geographic compliance reporting),
  payment and ledger rows, tax records, and the Razorpay reference ids.

⚠ **`ConsentArtifact` is left alone** — the consent record must outlive the
subject, pseudonymously. That is why the soft path and the hard path differ.
See `references/gotchas.md`.

### §B4 — Processor off-boarding (durable)

Every processor that holds the subject's data must be off-boarded **and the
obligation recorded**, because a process death between commit and the vendor
call loses it silently.

The pattern already in the codebase is an outbox row written **inside the
same transaction** and drained by a retry job (`StreamRevocationRetry`). Extend
it; do not invent a second mechanism.

Three outcomes must be distinguishable, and conflating them is a false negative
on the only control that exists:

| Outcome            | Meaning                                                                 | Action                                                                                                        |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Deleted**        | The processor confirmed deletion.                                       | Done.                                                                                                         |
| **Not configured** | We cannot reach the processor. The vendor copy is of **unknown state**. | Report as outstanding. An erasure that cannot confirm a processor's copy is gone has not discharged its duty. |
| **Failed**         | We tried and it did not work.                                           | Retriable.                                                                                                    |

⚠ `deleteSubscriber` conflates the first two — it returns `true` when Novu is
unconfigured. That is why `scrubUser` checks `isNovuConfigured()` separately.

### §B5 — Evidence

Per data class, per record: deleted / retained / action taken / basis / review
date. **Including the records where the decision was to retain**, and the basis
for it. A searchable erasure reference (e.g. `DEL-2026-NNNN`) is what an audit
asks for.

---

## C. Terms or privacy-policy rewrite

### §C1 — Establish the two-track structure

```
ToS change ─────► §C2 (contract)
New data purpose ► §A1 (consent)  ← ALWAYS a separate flow
A new processor ─► §C3, plus a DPA question
```

Never let one carry the other. See
`docs/market-research/01-consent-and-terms-landscape.md` §6.

### §C2 — The ToS change

1. **Does the current ToS contain an amendment clause?** If not, adding one is
   itself a material change requiring this whole procedure. **This is the
   blocking question — answer it first.**
2. **Classify materiality.** Define it _in the ToS_, tied to CPA 2019
   s.2(46)'s vocabulary so it reads as compliance rather than licence. Data
   changes are **always** material.
3. **Choose the mechanism**:
   - Material ⇒ publish + notify (email **and** in-app) + interposed
     re-acceptance at next login.
   - Immaterial ⇒ notify only.
   - Money-adjacent ⇒ add SMS (Zerodha's pattern).
4. **Record it** in a table **separate from `ConsentArtifact`**: userId,
   termsVersion, acceptedAt, channel, ip, userAgent. Append-only.
5. **Check the dark-pattern constraint.** EDPB 03/2022 names continuous
   prompting as deceptive, and the Consumer Protection (E-Commerce) Amendment
   Rules 2026 (**in force 1 Jan 2027**) import dark-pattern compliance. A
   per-login modal for immaterial changes is the failure mode.
6. **Email is a channel, never the only evidence**, and keep it
   promotional-free (TRAI UCC 2018).

⚠ **Notice quality does not save an unfair term.** CPA 2019 s.49(2)/s.59(2)
lets a Commission declare an unfair term null and void regardless of how well
it was communicated. That is a legal review question.

### §C3 — New processor

1. RoPA entry: name, purpose, data categories, hosting region, retention, and
   sub-processor or independent status.
2. DPA with India-storage, erasure, and breach-notification terms where
   relevant.
3. **Data residency is usually the wrong question.** DPDP imposes no
   localisation. What actually binds: CERT-In's 180-day in-India **log**
   retention, and RBI payment data — which reaches us _contractually_ through
   the payment provider, not by geography. The control is "never put payment
   payloads in telemetry", enforced in code.
4. If residency becomes a contractual requirement, see
   `docs/market-research/02-observability-vendors.md` §5.

---

## D. Answering "is this compliant?"

Work the claims register, not your memory.
`docs/market-research/05-claims-register.md` has every load-bearing claim with
a source and a confidence marker, plus a section of genuinely **open**
questions.

Say which of the two you are dealing with:

- **A row exists** ⇒ cite it, and say when it was checked.
- **No row exists** ⇒ the answer is a guess. Say so, and add the row.

**Never silently pick a side on an OPEN question.** The withdrawal-implies-
erasure ambiguity, the 22-language notice, and s.194-O vs s.194-J are legal
questions, not engineering ones.
