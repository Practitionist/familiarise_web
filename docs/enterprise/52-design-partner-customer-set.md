# Design-partner customer set

This document is the **single source of truth** for sales conversations during the design-partner phase (first 3-6 months post-MVP enterprise launch). It translates the current PR #682 readiness (~72-78%) into a concrete **yes / wait-list / hard-no** rubric for inbound prospects.

Reference for engineering: [#703](https://github.com/Practitionist/familiarise_web/issues/703) (Programs v2 + Compliance + Integrations) and [#706](https://github.com/Practitionist/familiarise_web/issues/706) (B2B Table-stakes + Deferred Integrations) contain the detailed sections linked below.

## Terminology

- **"Design-partner customer set"** — the group of customers accepted into the post-MVP enterprise launch. Deliberately narrow. Used interchangeably with "launch cohort" in strategy conversations.
- **NOT to be confused with** the `Class` Prisma model — that's a B2C cohort-based course appointment type, unrelated to this document.

## Section 1 — Yes-onboard profile

**Accept without hesitation** if ALL of the following hold:

| Criterion | Why it holds given current readiness |
|---|---|
| Indian organization (domestic) | GST + Razorpay + INR flows are the live paths |
| Sub-₹5 crore annual turnover | IRN e-invoice is mandatory only above this threshold ([#703 §2.1](https://github.com/Practitionist/familiarise_web/issues/703)); our uploader is real (env-gated daily cron, retry telemetry, ClearTax connector live in `lib/compliance/irp.ts`) and `FAILED`/`PENDING` rows are acceptable until the org crosses AATO |
| All consultants are resident PAN holders | TDS derivation in `lib/compliance/tds.ts` is live for 194-O default (1%), explicit overrides, PAN fallback (Section 206AA 20%), Section 197 lower-rate certs, and DTAA lookup. For resident PAN-holders it returns the correct withholding without manual override; FEMA Form 15CA/CB still manual until first non-resident consultant ships. |
| BUYER-type organization (sponsoring their own staff) | Core checkout flow + wallet / invoice / license funding paths are live; no PROVIDER-specific features (collaborators 3-way split) are needed |
| Pricing model is flat-fee OR pay-as-you-go | Programs v1 handles LICENSED_SEAT (flat-fee) + CREDIT_POOL (pay-as-you-go); milestone-billing (PROJECT) + hourly-retainer (RETAINER) are enum-reserved but unimplemented |
| INR-only contracts | Multi-currency + Razorpay IBT are deferred ([#703 §14](https://github.com/Practitionist/familiarise_web/issues/703)) |
| ≤100 active seats per org | SCIM 2.0 auto-provisioning + HRIS sync deferred ([#706 §13](https://github.com/Practitionist/familiarise_web/issues/706), [#703 §3](https://github.com/Practitionist/familiarise_web/issues/703)); manual invite management scales comfortably to ~100 |

**Typical prospect that fits:**
- Mid-sized Indian training company (80 employees, ₹3cr turnover) buying a flat-fee unlimited-coaching package for their managers.
- Tech startup (40 engineers) sponsoring 1-on-1 mentorship sessions, pay-as-you-go credits.
- Family-run consulting firm using Familiarise internally for professional development.

## Section 2 — Wait-list profile

Say **"this is on our roadmap, we're prioritizing customers like you — let's stay in touch"** if ANY of these hold. Capture them in the pipeline watchlist; each wait-list reason maps to a specific epic section whose demand-signal drives priority:

| Wait-list reason | Why waitlist | Unblocks when |
|---|---|---|
| ₹5 crore+ turnover | Needs live IRN e-invoice uploader | [#703 §2.1](https://github.com/Practitionist/familiarise_web/issues/703) — 1.5 eng-weeks |
| Any non-resident consultant in their pool | Needs FEMA compliance + DTAA TDS derivation | [#703 §2.2 + §2.4](https://github.com/Practitionist/familiarise_web/issues/703) — 1.5 eng-weeks combined |
| PROVIDER-type org (agency hosting multiple experts) with co-host webinars | Collaborators PROVIDER 3-way revenue split isn't wired | [#703 §4](https://github.com/Practitionist/familiarise_web/issues/703) — 1 eng-week |
| Milestone-based fixed-price engagements (McKinsey-style) | Programs v2 PROJECT config tables not built | [#703 §1](https://github.com/Practitionist/familiarise_web/issues/703) — 2 eng-weeks |
| Hourly retainer with monthly cap (GLG-style expert networks) | Programs v2 RETAINER config tables not built | [#703 §1](https://github.com/Practitionist/familiarise_web/issues/703) — part of the 2 eng-weeks above |
| USD / EUR / GBP contracts | Multi-currency checkout + Razorpay IBT routing absent | [#703 §14](https://github.com/Practitionist/familiarise_web/issues/703) — 1.5 eng-weeks |
| Requires downloadable invoice PDFs | Invoice PDF rendering ships in this push (#706 §2) | **AVAILABLE at launch** — re-categorize to Section 1 |
| Requires per-org branded emails | Branded email templates deferred | [#706 §10](https://github.com/Practitionist/familiarise_web/issues/706) — 0.5 eng-weeks |
| Needs IdP-driven auto-provisioning but <500 seats | SSO JIT provisioning deferred | [#706 §4](https://github.com/Practitionist/familiarise_web/issues/706) — 1 eng-week |
| Needs Slack / Datadog / Splunk integration | Platform → tenant webhooks + audit streaming deferred | [#706 §17 + §19](https://github.com/Practitionist/familiarise_web/issues/706) — 1 eng-week each |
| Asks for 2FA enforcement org-wide | Policy not wired | [#706 §14](https://github.com/Practitionist/familiarise_web/issues/706) — 0.5 eng-weeks |
| Asks for org-scoped discount codes | Not implemented | [#706 §9](https://github.com/Practitionist/familiarise_web/issues/706) — 0.25 eng-weeks |

**Pipeline triage rule:** when three or more wait-listed prospects cluster around the same blocker, promote that blocker to the top of the engineering backlog. One prospect = demand signal; three = clear customer pull.

## Section 3 — Hard-no profile

**Decline and refer elsewhere** if any of these hold. These require features that are either 2+ eng-weeks of work OR are explicitly post-Phase-3:

| Hard-no reason | Reference |
|---|---|
| Requires white-label UI + wholesale-resale margins (channel-partner is OK; full reseller is not) | [#706 §1.4 (RESELLER Option B)](https://github.com/Practitionist/familiarise_web/issues/706) — 2 eng-weeks; ship only on named-customer demand |
| >500 seats needing SCIM 2.0 auto-provisioning + de-provisioning | [#706 §13](https://github.com/Practitionist/familiarise_web/issues/706) — 2-3 eng-weeks |
| Hard requirement for sandbox / test-tenant mode before signing | [#706 §23](https://github.com/Practitionist/familiarise_web/issues/706) — 2 eng-weeks |
| Requires ISO 27001 / SOC 2 certification in the next 12 months | Not a software feature; a full audit cycle — out of scope for design-partner phase |
| Wants Familiarise to act as employer-of-record (EOR) for consultants | [#703 §12 (AOR/EOR)](https://github.com/Practitionist/familiarise_web/issues/703) — 1.5 eng-weeks + tax integration |
| Wants real-time SCIM groups-to-MemberRole sync across 10+ custom roles | [#706 §7 (Option B custom roles)](https://github.com/Practitionist/familiarise_web/issues/706) + [#706 §13 (SCIM)](https://github.com/Practitionist/familiarise_web/issues/706) — 4+ eng-weeks combined |

## Section 4 — Pipeline triggers

Add each wait-list prospect to `docs/sales/enterprise-pipeline.md` (not this file — keep the customer-set rubric stable). The engineering team reviews the pipeline monthly; when a blocker has accumulated sufficient demand, it promotes into active sprint work.

Tag format for pipeline entries:
- `@section703-section-N` — blocker from #703 section N
- `@section706-section-N` — blocker from #706 section N
- `@out-of-scope` — hard-no categories

Example pipeline entry:
```
Company: Tata Consultancy Services (TCS Fintech division)
Contact: Priya Desai <priya.desai@tcs.com>
Ask: 500-seat subscription for graduate trainees; requires SSO JIT provisioning and SCIM.
Blockers: @section706-section-4 (SSO JIT) + @section706-section-13 (SCIM)
Decision: wait-list. Confirmed fit otherwise (resident consultants, INR, sub-₹5cr-division-scoped).
Last contact: 2026-04-15.
```

## Section 5 — Support posture for accepted customers

Customers in Section 1 who onboard should expect the platform at design-partner quality:

- **Manual ops backups available**: if they hit a refund / erasure / hierarchy need that's only supported via platform-admin tooling, support will handle it within 1 business day.
- **Feature-request fast-path**: design-partner requests bypass the normal backlog if they align with #703 / #706 roadmap items.
- **Bug SLA**: P0 (blocking) 24h, P1 (impacting) 3 business days, P2 (nice-to-have) next sprint.
- **Monthly check-in**: engineering joins a 30-min review call to surface friction.

This posture is intentional; it's how Slack, Notion, and Linear ran their enterprise betas. The tradeoff is signed contracts with explicit "this is a design-partner program" language — not full-price, full-SLA deals.

## Decision tree for sales

```
Inbound prospect contacts us.

  1. Profile matches Section 1? 
       └─ YES → propose design-partner terms. Close the deal.

  2. Any Section 3 trigger applies?
       └─ YES → decline politely, refer to a vendor that fits.

  3. Otherwise → Section 2 wait-list.
       ├─ Capture in pipeline with correct tag.
       ├─ Send a "roadmap updates" opt-in email.
       └─ Re-engage when the blocker ships.
```

## Review cadence

This document is reviewed at the start of each quarter. When the underlying readiness shifts (e.g., #703 §2.1 IRN ships), update Section 2 → Section 1 migrations and re-tag open pipeline entries.

Owner: Head of Sales (until headcount; interim = product lead).
