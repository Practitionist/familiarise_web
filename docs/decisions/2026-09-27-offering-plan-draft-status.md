# ADR: A real draft status for 1:1 and subscription plans

- **Status**: Accepted
- **Date**: 2026-09-27
- **Part of**: #1527 decision Q4, PR #1842

## Context

The consultant offering editor had a "Save draft" action for 1:1 consultation plans and subscription plans, but neither `ConsultationPlan` nor `SubscriptionPlan` had a status column: the editor hard-coded every save as published, so "Save draft" published the plan regardless of what the button said, and the badge shown to the consultant read "Published" even on a plan the consultant believed was still a draft. Webinar and class plans did not have this problem — their drafts already live on `Webinar.status` and `Class.status = DRAFT` respectively — but the two plan types that make up most of an individual expert's catalog had no way to stage an offering before it went live.

The owner's decision (Q4) was to add a real status column now, as a schema change, rather than defer it, choosing this over the alternative of shipping a UI-only "looks like a draft" affordance with no backing state.

## Decision

### Schema

```prisma
enum OfferingPlanStatus {
  DRAFT
  PUBLISHED
}
```

`ConsultationPlan` and `SubscriptionPlan` each gained `status OfferingPlanStatus @default(PUBLISHED)`. This is additive and default-backed: on PostgreSQL 11 and later, which includes the Supabase Postgres this app runs on, adding a column with a constant default is a metadata-only operation, so every existing row reads as `PUBLISHED` without a backfill pass, and code that had not yet been updated to read the new column continued to behave exactly as before deployment. `WebinarPlan` and `ClassPlan` were not touched, because their existing status fields already cover the same need.

### What is gated

A `DRAFT` plan is invisible to a public or buyer-facing read, and any attempt to act on one as a buyer is refused with a new `PLAN_NOT_PUBLISHED` business-error code:

- **Discovery reads** — the explore pages, the per-expert pricing surface (`lib/data/consultant-detail.ts`, which previously filtered nothing and so also closed a pre-existing ORG_ONLY/archived leak on the same surface), the org member catalog, and the public branches of the plan-detail APIs — all exclude `DRAFT` plans.
- **Buy and book refusals** — `checkout.ts`'s `assertPlanPurchasable`, the request-for-approval flow, and trial creation and eligibility checks all refuse a `DRAFT` plan with `PLAN_NOT_PUBLISHED` before any money or scheduling logic runs.
- **The plan-detail API** — the owner's own `GET` on a `DRAFT` plan still succeeds (so the owner can preview their own draft), but a non-owner requesting the same plan gets a 404 rather than the plan's content, and the detail response no longer includes the plan's `consultations` relation at all, which previously returned booking rows to any signed-in caller regardless of ownership.
- **The editor** — "Save draft" now genuinely writes `DRAFT`; "Publish" maps the plan to `PUBLISHED`; the status badge on the editor and on the Offerings list reads the real column instead of always showing "Published"; Duplicate creates a new plan as a `DRAFT`; and unpublishing a live plan (`PUBLISHED` → `DRAFT`) requires a confirmation, because the platform's default behaviour for turning off a purchasable plan should not be a single, undoable click.

### What is deliberately not gated

Unpublishing a plan does not touch anything that already happened against it. Pay-link minting for an approval-payment flow, any read that happens inside the checkout lock or on payment confirmation, webhook processing, the overage preview, and reads of an existing booking (`bookings/*/[id]`) are all untouched by this status column. The plan's `DRAFT`/`PUBLISHED` status governs whether a **new** sale can start against it; it has no bearing on a sale that already exists. Concretely, this means an approved-but-unpaid request against a plan that its owner later drafts can still be paid for and fulfilled — drafting a plan never stranded an in-flight, already-approved booking. This was confirmed directly during this PR's CodeRabbit review round: a finding asked whether unpublishing a plan with live consultations should be blocked outright, and the answer, consistent with this design, was that it should remain allowed (behind the existing typed-confirm dialog) precisely because unpublishing does not affect bookings that already exist.

## Consequences

### Positive

- "Save draft" now does what its label says, closing a defect where a consultant's unfinished pricing or content changes went live the moment they clicked what they believed was a safe, non-publishing action.
- The plan-detail API no longer leaks booking rows to an arbitrary signed-in caller, and a non-owner can no longer distinguish a real draft plan from a nonexistent one beyond a generic 404.
- Because the column is additive with a default, the rollout needed no backfill. It did not by itself guarantee that old code ignored drafts: while an old deployment and new draft writes overlap, old readers such as `generateMetadata` and `api/topics` can still show or count a draft plan. The protection is that the readers and purchase gates changed in the same PR that introduced drafts, so the overlap lasts only as long as a deploy is rolling out.

### Negative

- Two related gaps were found at PR-open time: the plan-detail page's `generateMetadata` initially still put a `DRAFT` plan's title into the page `<title>` even though the page itself correctly 404'd, and `api/topics`'s public counts initially still counted `DRAFT` (and ORG_ONLY, and archived) plans, over-counting what a visitor sees advertised. Only the first is fixed: the `generateMetadata` fix landed in this PR. The `api/topics` count is not yet fixed — `withProgramCount` still counts every `ConsultationPlan`/`SubscriptionPlan` row against a topic with no status filter — and remains tracked in issue #1845 for the reads that were not yet migrated onto the same visibility helper.
- The reserved schema fields from the wider #1527 decision 5 (`ProgramStatus.DRAFT`, `Contract.version`, `Program.version`, `RescheduleRequest.supersedesId`, `Trial.refundedAt`) remain out of scope; only the consultation/subscription draft status shipped in this PR.

## References

- #1527 decision Q4 — the owner's choice to add the schema column now rather than defer it.
- PR #1842 — the implementation, including the discovery-read and checkout-refusal call sites.
- `lib/api/plans/visibility.ts` — the gate functions (`oneOnOnePlanDiscoverableWhere`, `planSaleRefusal`, the `isPlanViewable` status arm).
- Issue #1845 — the tracked follow-up for `api/topics`'s remaining over-count.
