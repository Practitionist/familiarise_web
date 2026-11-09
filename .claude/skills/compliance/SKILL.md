---
name: compliance
description: Work on this repo's DPDP/consent/erasure/retention subsystem and the India-first compliance posture — the consent state model and its fail-closed gate, withdrawal versus erasure, the per-data-class retention engine, the processor inventory and vendor off-boarding, the terms-vs-privacy-policy change mechanism, and the staged DPDP commencement dates. Use when the user says "DPDP", "consent", "DPDP compliance", "privacy policy", "terms of service", "right to erasure", "delete my data", "data retention", "grievance", "RoPA", "processor", "India compliance", "cross-border transfer", "CERT-In", "data residency", "age gate", "18+", "minors", "signal retention", or is touching lib/compliance/, lib/novu/, lib/newsletter/, prisma's ConsentArtifact or ErasureRequest models, app/api/users/me/erasure-requests/, app/api/organizations/[orgId]/consent/, components/dashboard/account/ConsentSection.tsx, jobs/compliance/, or docs/compliance/.
---

# Compliance

The index for the data-protection domain: what a person agreed to, what that
permits, how it stops, and how it is proven to a regulator. The facts live in
`docs/compliance/`; this skill holds the doctrine
and the decision procedure.

Marketing consent for the newsletter (one `MARKETING_COMMS` ledger for accounts and guests, the lock order and erasure) is described from the product side in the `growth` skill (`.claude/skills/growth/SKILL.md`).

## Standing instruction — India-first

**The default legal frame is Indian law.** DPDP Act 2023 + DPDP Rules 2025, IT Act
2000, IT Rules 2021, Consumer Protection Act 2019, CERT-In Directions 2022, CBDT
s.194-O. ~90% of customers are Indian. Reach for GDPR/CCPA only for the foreign
slice, and label it as such.

Full reference, including the staged commencement dates and what is enforceable
_today_ versus in 2027: **`docs/compliance/01-india-first-posture.md`**. The dates
to quote: the DPDP Rules are G.S.R. 846(E) of 13 Nov 2025 (14 Nov is only the
press-release date), Rule 4 starts 13 Nov 2026 and the substantive duties about
13 May 2027; the E-Commerce (Amendment) Rules 2026 (G.S.R. 789(E)) start
1 Jan 2027, tracked in #2666.

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
- **Vendors get minimal fields.** Stream receives only `id`, `name`, `image` and `role` under `STREAM_DATA_PROCESSING` (`lib/compliance/purpose-codes.ts`), built by `toStreamUser()`; `stream-sync` unsets older contact fields.
- **Vendor work is durable.** A process death between commit and the processor
  call must not lose the obligation. Outbox row in the same transaction, drained
  by a retry job.
- **The burden of proof is on us** (DPDP s.6(10)). An unread email is not
  evidence. Version-pin everything.

## Re-use

The intended use of this work is **another company**. So:

- The portable architecture is four separations (contract acceptance versus
  data-processing consent, consent versus erasure, state versus evidence,
  gate versus policy), a whitelist consent gate, a per-data-class retention
  engine and a jurisdiction registry. A new country is a new entry in
  `jurisdictions/`, never a rewrite.
- Every decision should trace to a claim with a source, a date checked and a
  confidence marker. **A decision with no such claim is a guess.**
- Do not copy the India answers. Copy the questions and the sources.

## Adults only, and the fraud signals

- **18+ only (owner decision, 2026-11-09).** Never build a parental-consent, guardian or minor flow. `DateOfBirthSchema` (`lib/compliance/age.ts`) is the one rule, and the date of birth is the only age ask: one neutral date field (the 18 cutoff is not named before entry; an under-18 date shows `UNDER_AGE_MESSAGE` inline and the server refuses it), no "I am 18" checkbox and no `adultConfirmed` field (owner decision, 2026-11-09). The wizard, the gate (`completeOnboardingGateAction`) and the organisation-create `onboarding` block each parse an 18+ `dateOfBirth`. `claimOnboardingCompletion` stamps `User.adultConfirmedAt` (server time) when the date of birth it is given passes `isAdult`, and the data export includes it; a new completion path must pass its parsed `dateOfBirth` in. Operator accounts (`lib/auth/operators.ts`) are created already onboarded with no date of birth and are not stamped. A new route that stores a date of birth or completes onboarding must parse it with `DateOfBirthSchema` and refuse with a typed `VALIDATION` error on `dateOfBirth`; `PUT /api/user/[id]` does and no longer accepts `onboardingCompleted`. The Terms (3.1 Eligibility) and the privacy policy (section 8) say the same; keep the three in step.
- **Signal retention.** `Referral.ipHash` and `userAgent` are nulled 180 days after the referral is terminal, 180 days after creation if it never settles (`SIGNED_UP`, `QUALIFIED`, `QUALIFYING`, `HELD`), and in `scrubUser`; the user-agent is stored as sent, not hashed, and the privacy page says so; `Payment.payerVpaHash` and `payerPhoneHash` are nulled 2 years after capture and stay through erasure until then. The windows and predicates are in `lib/compliance/signal-retention.ts`, run by the daily `prune-audit-logs` job. Do not add a job or a Redis lock for them.
- **Consent artifacts are kept 7 years** (`auditRetainedUntil`): proof of consent under DPDP s.6(10) plus the limitation periods, with counsel to confirm. No code.
- **Policy copy names only integrated vendors.** The processor list is privacy section 4.2, the export's `sharedWithDataProcessors` and the table in `docs/compliance/02-dpdp-and-privacy.md`; Stripe, Neon, Google Analytics and Hotjar are not integrated and must not be named. Add a processor to all three together, and bump the matching `POLICY_DATES` entry (`app/(pages)/constants.ts`) on any change to a policy page. `TERMS_VERSION` moves only when a `PURPOSE_CODE_META` text changes.
- **Grievance numbers.** The promise is 24 hours to acknowledge and 7 days to resolve (`lib/support/sla.ts`); 15 days, 48 hours and one month are statutory ceilings, never our promise.
- **Tax positions** that this posture rests on (s.9(5) not applicable, no s.52 TCS under the principal model, s.194R not applied, all pending the accountant) are in `docs/compliance/01-india-first-posture.md` and `docs/decisions/2026-11-09-tax-compliance-and-pricing-levers.md`.

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
- Vendor-side copies are part of erasure. `scrubUser` deletes the R2 object,
  the preview folder (clip and thumbnail), the transcript and Stream's copy of
  the user's 1:1 recordings; the row is marked `EXPIRED` only after the vendor
  confirms. A failed vendor delete fails the erasure and stays retryable —
  never downgrade it to a database-only delete.

## Marketing consent, newsletter, cookies, mail erasure

- `MARKETING_COMMS` is the only marketing control. Its grant upserts the account's `NewsletterSubscriber` row `SUBSCRIBED` in the same transaction as the artifact; its withdrawal unsubscribes the account's rows (`lib/newsletter/consent-link.ts`, called from `app/api/user/privacy/consent/route.ts`). No double-opt-in email: the artifact is the evidence.
- The newsletter unsubscribe (`unsubscribe` in `lib/newsletter/service.ts`) commits first, then withdraws a linked account's `MARKETING_COMMS` in its own best-effort transaction. Never put the two in one transaction, and never answer "unsubscribed" when the write failed.
- Offer only `OFFERED_PURPOSE_CODES`. `ANALYTICS` is kept for stored artifacts but never offered or granted until a real analytics tool exists; do not write copy that claims analytics or telemetry.
- Every marketing grant records `consentProvenance(headers)` (`lib/newsletter/consent-link.ts`): the middleware-stamped IP via `lib/request-ip.ts` and the user agent.
- Look consent up by purpose (`purposeCodeAliases`), never by a notice `version`. Grants stamp `TERMS_VERSION` on the server (currently 4); bump it when any purpose text in `PURPOSE_CODE_META` changes, and render purpose text only from `PURPOSE_CODE_META`. User-facing consent copy is plain words: never render a purpose code, `ust_` token or statute citation; the shared notice is `components/compliance/DataProtectionNotice.tsx`.
- `NotificationPreference.marketingEmails` and `CookiePreference` are unread; never add a reader or writer. There is no cookie banner: the site sets essential cookies only. Adding any non-essential script needs a consent prompt and a privacy-policy update first.
- Erasure's mail scrub is `scrubMailFootprintTx` (`lib/compliance/erasure/mail-footprint.ts`), inside the `scrubUser` transaction: `NewsletterSubscriber` rows deleted and the address's pseudonymous `MARKETING_COMMS` artifact withdrawn, queued `FailedEmail` dead-lettered `policy:recipient_erased` and redacted, `recipient` on every `FailedEmail` row (settled too) and the `newsletter:<address>` / `contact:<address>` `entityRef` replaced by an `erased:<digest>` marker that `emailPolicyRefusal` and `emailReplayRefusal` refuse, the address removed from every batch (`review:erased_recipient` when a queued batch's key may have been seen). `EmailSuppression` is kept on purpose so the address stays unmailable. Bells are dropped at send time (`unerasedRecipients`). Proof: `__tests__/db/erasure-mail-footprint.db.test.ts`.
- Erasure also deletes the user's `AppointmentWaitlist` (notify-me) and `WindowBackupInterest` rows inside the `scrubUser` transaction; the stale-requests job deletes settled `AppointmentWaitlist` rows 30 days after their last change and settled `WindowBackupInterest` rows 30 days after `windowEnd` (`purgeSettledBackupInterest`).

For how the breach and MSME alert emails are routed and guarded, see [docs/email/README.md](../../../docs/email/README.md).

## Dark patterns and the displayed certificate

Any change to pricing, checkout, promo, ranking, consent, notification copy or uploads re-opens a row of [the dark-pattern self-audit](../../../docs/compliance/07-dark-pattern-self-audit.md); add the finding there. Orders shown to buyers must match `/how-we-rank` (`app/(pages)/how-we-rank/page.tsx`), and no placement may be paid for unless it is labelled Sponsored. The certificate page `/compliance-certificate` returns 404 until `DARK_PATTERN_AUDIT` in `lib/company.ts` has a signatory name and signing date; never fill them without the director's signature. An anonymous grievance complainant gets a copy of the complaint only after their address is confirmed.

## Breach deadline staging

Preserve the boundary between recipient transactions and digest completion when
refactoring `lib/compliance/databreach-deadline-alerts.ts`. Stage recipients
sequentially with budget checks; keep email and notification obligations on the
supplied transaction client. Aggregate errors before deciding completion, including
an invalid officer configuration that must still allow eligible admins to stage.

Retention and deadline workers preserve the original caller `startedAt` across maintenance checks, lease admission and batch slices. Check the budget after awaited selection/officer/chat work before admitting another write; timeouts leave continuation visible. Keep the existing consent-delete gate and stored retention deadlines. [Worker contracts and verification](../../../docs/maintenance/compliance-retention-workers.md) also document the ticker owner and operator recovery.

## Environments share one database

Every preview, the branch deploy and local development read and write production's rows, so treat a QA identity as a production identity: real operators keep 2FA on every deployment, only the exempt list in `lib/auth/qa-accounts.ts` skips it off production, and the seeded TOTP operators are repaired only by the owner with `scripts/auth/repair-qa-operator-2fa.ts --apply`. The vendor × environment matrix is [docs/start-here/10-environment-split.md](../../../docs/start-here/10-environment-split.md).

## Retention windows

Every log-like and audit table has a window, a legal driver and a named prune job. Read [the retention table](references/retention-windows.md) before adding or changing any of them; the same table is in `docs/compliance/02-dpdp-and-privacy.md`.
