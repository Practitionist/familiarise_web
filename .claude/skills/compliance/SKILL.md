---
name: compliance
description: Work on this repo's DPDP/consent/erasure/retention subsystem and the India-first compliance posture — the consent state model and its fail-closed gate, withdrawal versus erasure, the per-data-class retention engine, the processor inventory and vendor off-boarding, the terms-vs-privacy-policy change mechanism, and the staged DPDP commencement dates. Use when the user says "DPDP", "consent", "DPDP compliance", "privacy policy", "terms of service", "right to erasure", "delete my data", "data retention", "grievance", "RoPA", "processor", "India compliance", "cross-border transfer", "CERT-In", "data residency", or is touching lib/compliance/, lib/novu/, prisma's ConsentArtifact or ErasureRequest models, app/api/users/me/erasure-requests/, app/api/organizations/[orgId]/consent/, components/dashboard/account/ConsentSection.tsx, jobs/compliance/, or docs/compliance/.
---

# Compliance

The index for the data-protection domain: what a person agreed to, what that
permits, how it stops, and how it is proven to a regulator. The facts live in
`docs/compliance/` and `docs/market-research/`; this skill holds the doctrine
and the decision procedure.

## Standing instruction — India-first

**The default legal frame is Indian law.** DPDP Act 2023 + DPDP Rules 2025, IT Act
2000, IT Rules 2021, Consumer Protection Act 2019, CERT-In Directions 2022, CBDT
s.194-O. ~90% of customers are Indian. Reach for GDPR/CCPA only for the foreign
slice, and label it as such.

Full reference, including the staged commencement dates and what is enforceable
_today_ versus in 2027: **`docs/compliance/00-india-first-posture.md`**.

| Reference                          | Purpose                                                                                                                                                                                         | Read it when                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `references/decision-procedure.md` | The branching procedure for a consent change, a withdrawal, an erasure request, or a terms/privacy rewrite — which instrument applies, what state transition follows, what evidence must exist. | First, for any of those four asks.             |
| `references/gotchas.md`            | The specific defects this subsystem has had, and the class of mistake each one represents.                                                                                                      | Before changing anything in `lib/compliance/`. |

## The four separations

Everything in this domain follows from these. They are table boundaries, not
conventions, and collapsing any of them is how the design breaks.

1. **Authn ⇄ Consent.** Two machines, two tables, two audit streams. Login
   success is not consent; never derive one from the other.
2. **Withdrawal ⇄ Erasure.** Two events, two states, two records. One may
   _impute_ the other (PECR/ICO do); the audit must show which was requested.
3. **Subject ⇄ Processing.** Consent is per (subject × purpose × notice
   version). Never a user-level boolean — bundling is the named anti-pattern.
4. **Consent axis ⇄ Retention axis.** Legal hold and retention suppress over
   _retention_, orthogonally. A hold on the consent axis destroys the evidence
   you need to defend the hold.

## The gate

```ts
// Fail-closed whitelist. Everything not matching is a denial.
MAY_PROCESS(purpose) :=
    state(purpose) == GRANTED
 && noticeVersion(purpose) == CURRENT_NOTICE_VERSION
 && !retention.onHold(subject, dataClass)
 && now < retention.until(subject, dataClass)
```

**Collapse to deny at the gate; keep the states distinct in the machine.** This
is the reconciliation between CNIL's "any inaction is a refusal" and the Consent
Manager APIs' ability to record _why_ there is no consent. Both are right, at
different layers. Building only the legal view is the standard mistake.

## Doctrine

- **A ToS re-acceptance can never carry new data-processing consent.** Separate
  instruments, separate records, separate withdrawal mechanics. India has no
  express anti-bundling clause today; that is not permission.
- **Withdrawal is prospective and purpose-scoped.** It does not delete data
  already collected, and in-flight orders survive (DPDP s.6(5)).
- **New notice text ⇒ new record, never a relabel.** Shipping new copy must
  invalidate old grants against the new text.
- **Erasure is a per-data-class decision, recorded per record** — including the
  decisions to retain, and why. Absence of deletion is evidence too.
- **Read consent at the point of processing, not at enqueue.** Never trust a
  consent value copied into a job payload or a stale tab.
- **Vendor work is durable.** A process death between commit and the processor
  call must not lose the obligation. Outbox row in the same transaction, drained
  by a retry job.
- **The burden of proof is on us** (DPDP s.6(10)). An unread email is not
  evidence. Version-pin everything.

## Re-use

The intended use of this work is **another company**. So:

- The portable architecture — state machines, gate, retention engine,
  jurisdiction registry — is in `docs/market-research/04-reusable-substrate.md`.
  A new country is a new entry in `jurisdictions/`, never a rewrite.
- `docs/market-research/05-claims-register.md` is the pattern to extend: every
  decision traces to a row with a source, a date checked, and a confidence
  marker. **A decision with no row is a guess.**
- Do not copy the India answers. Copy the questions and the sources.

## Money-adjacent consequences

Erasure and consent both intersect the money path, and the reasoning is not
obvious from the compliance side alone. `/finance` and `/enterprise` own it.

- The money-in-flight gate on erasure is a **correctness** requirement, not a
  compliance nicety: failing a settlement in flight is unrecoverable.
- `ConsentArtifact` is `onDelete: Cascade`. A hard account delete takes the
  consent ledger with it; `scrubUser` correctly leaves it. Two deletion paths,
  opposite answers — see `references/gotchas.md`.
- Statutory retention (tax, accounting) **overrides** erasure. That is not a
  failure to comply; it is the reason the retention engine records a basis
  instead of deleting.

For how the breach and MSME alert emails are routed and guarded, see [docs/email/README.md](../../../docs/email/README.md).
