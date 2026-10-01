# Market research: India digital-health & consultation platforms

**Purpose.** Vendor and pattern research for a reusable compliance + platform
substrate. Written to be lifted into other companies, so every entry records
_what was verified, when, and from which source_ rather than a conclusion that
goes stale silently.

**Research date: 2026-09-29.** Prices, regions and product surfaces change. Re-verify
before acting on any number here.

## Index

| #   | Document                                                                  | What it settles                                                                                    |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 00  | This index                                                                | Orientation, how to re-use, confidence legend                                                      |
| 01  | [The Indian consent & terms landscape](01-consent-and-terms-landscape.md) | How Indian companies actually notify a terms change; what the law requires vs what the market does |
| 02  | [Observability vendor landscape](02-observability-vendors.md)             | Sentry vs SigNoz vs GlitchTip vs CubeAPM vs Datadog vs Better Stack; the recommendation and why    |
| 03  | [Competitor pattern catalogue](03-competitor-patterns.md)                 | Per-company mechanisms observed, with verbatim terms and the pattern each one represents           |
| 04  | [Reusable compliance substrate](04-reusable-substrate.md)                 | The portable architecture: state machines, retention engine, jurisdiction model                    |
| 05  | [Claims register](05-claims-register.md)                                  | Every load-bearing legal and technical claim, its source, and its confidence                       |

## How to re-use this for another company

The temptation is to copy the answers. **Don't — copy the questions and the
sources.** Concretely:

1. **`04-reusable-substrate` is the portable part.** The consent state machine,
   the withdrawal-vs-erasure separation, the retention engine, and the
   jurisdiction model are jurisdiction-neutral. A new market is a new entry in
   `jurisdictions/<market>/`, not a rewrite.
2. **`01` and `02` are India-specific and dated.** They are a baseline, not a
   template. Their value is the _method_ — what to check, where to look, and
   which vendor claims turned out to be false.
3. **`05-claims-register` is the thing to extend first.** Every compliance
   decision should trace to a row. A decision with no row is a guess.

## Confidence legend

Used throughout, because vendor marketing and vendor reality diverge sharply.

| Marker         | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| **VERIFIED**   | Read directly off the vendor's own pricing page, docs, or code on the research date. Reproducible. |
| **CLAIM**      | Vendor marketing. Not independently substantiated. Treat as a hypothesis.                          |
| **UNVERIFIED** | Could not confirm. Absence of evidence, not evidence of absence.                                   |
| **ABSENCE**    | Actively searched for and not found (e.g. "no server-side scrubber"). Stronger than UNVERIFIED.    |

## Why this is organised this way

Two traps made the obvious structure fail:

- **Organising by company** buries the patterns. The interesting thing about
  Groww and Freshworks is not who they are, it is that both use a
  _post-and-continue_ clause and neither forces re-acceptance. `03` is therefore
  indexed by _mechanism_, with companies as instances.
- **Organising by legal instrument** produces confident answers to questions the
  law has not settled. The withdrawal-implies-erasure question has three
  different regulator answers and no CJEU ruling on point. `05` records it as
  open rather than picking a side.

## Research provenance

Three parallel research passes (self-hosted/India-residency vendors; global
majors; our own repo's Sentry surface), plus direct verification of the most
load-bearing pricing claim on the vendor's own page. Repo analysis was
read-only.

Coverage and known gaps:

| Covered                                              | Not covered                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Terms/consent change notification, India             | Payment gateway vendor terms (Razorpay, Cashfree) — not researched         |
| Consent state machine, internationally               | Health/clinical data specifics — out of scope, we are not a covered entity |
| Error/observability vendors, thorough                | APM for mobile — we have no mobile app                                     |
| DPDP, CERT-In, CPA, IT Rules, RBI (as it reaches us) | State-level law — confirmed none exists for data                           |
| DPDP ↔ GDPR comparison                               | Sector regulators we do not touch (DoT, PFRDA, SEBI)                       |

The gaps are deliberate: each is either not applicable to a B2C consultation
marketplace or would require legal input to be actionable. `04` states the
assumptions so a future reader knows what was never asked.
