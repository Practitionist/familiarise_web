# Architecture: one rating per call, per person

`AppointmentFeedback` answers "how was that call?" for one participant. This page describes what a row is anchored to, who may write one, how the API reads and writes it, what an edit means, and how a row is removed.

## The unit is the appointment occurrence, or the whole appointment

The table below maps the words people use to the canonical names in [the glossary](../enterprise/00-foundations/07-scheduling-glossary.md); the feedback row hangs off the third line. For every booking shape and organisation relationship multiplied out, see [grid F](../support/02-the-grid.md#f--the-grid-multiplied-out-feedback-and-review-by-shape-and-organisation).

| What people say           | Canonical name         | Model                                    | What it is                                                                                   |
| -------------------------- | ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| "slot" on the calendar     | availability window     | `AvailabilityWindowWeekly` / `...Custom` | The hours a consultant offers; never booked directly and never rated                          |
| "slot" in the picker       | bookable interval        | transient `AvailabilityInterval`         | A computed cut of availability that exists only until checkout                                |
| "the session", "the call"  | appointment occurrence   | `AppointmentOccurrence`                  | One held call row with `startsAt`, `endsAt`, `ordinal` and `completionStatus`                 |
| "the booking"              | appointment              | `Appointment`                            | The purchase wrapper around exactly one consultation, subscription, webinar, class or trial   |
| "the video call"           | meeting                  | `Meeting`                                | The Stream record for one appointment occurrence, created lazily at Start Call                |

A rating is about a conversation, so `AppointmentFeedback.appointmentOccurrenceId` points straight at the occurrence being rated — there is no run-anchor grouping to resolve any more, because the reset deleted the thirty-minute atom rows an occurrence used to be assembled from. The column is nullable: `NULL` means the rating is about the whole appointment rather than one call, which is the shape a subscription or class purchase needs when nobody rates each individual meeting separately. Both levels are enforced by one `NULLS NOT DISTINCT` sidecar unique, `appointment_feedback_level_key`, on `(appointmentId, appointmentOccurrenceId, userId)` — it treats two `NULL` occurrence ids for the same appointment and user as the same row, which is exactly the "one whole-appointment rating per person" rule, and treats two different occurrence ids as different rows, which is the "one rating per call per person" rule.

Eligibility is `heldOccurrence(userId)` from `lib/reviews.ts`, the same predicate the public review uses: the occurrence completed or is `UNVERIFIED`, it was not cancelled or rescheduled, and either the caller has an attendance row and the call is over, or nobody could have recorded attendance because the call ran offline. A `COMPLETED` occurrence the user never joined used to qualify, so a no-show could rate a call they did not attend and it fed the consultant's quality signal.

`appointmentId` is denormalised beside the occurrence because the org aggregate and every appointment-scoped read filter on it, and it avoids a join on the hottest path. `organizationId` is copied from the appointment at write time for the same reason. `consultantProfileId` is denormalised too (#1550) — the consultant on the rated call, or the plan's consultant for a whole-appointment rating — so the org rollup can `groupBy` consultant without a join back through the appointment; `coPresenterProfileId` (#1580) does the same for the PRESENTER collaborator on the rated call's plan, if any.

## Who rates whom: `raterRole`, and why unknown provenance fails closed

The `POST` authorizes any participant, so without a role column a consultant's rating of their own session was indistinguishable from an attendee's and landed in the organisation's quality average. `appointmentRaterRole(userId, detail)` in `lib/data/appointment-detail.ts` decides which side the caller is on, and `PROVIDER` wins a tie: a consultant who is somehow also on the attendee list must not be counted as an attendee, because their CSAT would then be a rating of their own work. A caller who is neither is refused with a 403.

`raterRole` is nullable and never backfilled. Rows written before the column cannot be attributed, and asserting `CONSULTEE` over them would re-admit exactly the self-ratings being excluded. Every aggregate therefore filters _on_ `CONSULTEE` rather than excluding `PROVIDER`, so a row of unknown provenance fails closed. The same call is made for `ConsultantReview.track`, where a legacy row contributes to neither published score.

Staff can read a rating and must not be able to author one. Read access is never write access, and the role derivation is what enforces it: platform staff are not participants, so they have no `raterRole`.

## The API

`GET /api/appointments/[appointmentId]/feedback` returns the caller's own ratings (score, note, occurrence id) when the caller is an attendee, and every attendee's **score only** when the caller is the provider. Every comment in this table was typed into a card whose own header called it private per-participant CSAT, and the row that replaced that card takes stars only, so it cannot re-ask for consent that was never given. The provider's list is ordered by `createdAt` ascending rather than by anything a provider could use to infer a rater on a group call.

`scope=booking` was added to widen the answer to a booking's sibling appointments in one request (#1540), back when a subscription or class booking could span several child `Appointment` rows. #1554 made a booking exactly one `Appointment` with N occurrences, so `scope=booking` and the default now read the same row; the query parameter is still accepted so existing callers do not 400, but it no longer changes behaviour. The timeline renders every occurrence of the appointment from that one row. `SessionRatingRow` (in `hooks/useSessionFeedback.ts` — the file name predates #1554 and still says "session") posts against the appointment and invalidates the same `bookingFeedbackKey` so the writer and the reader cannot drift.

`POST` upserts one row for `(appointmentId, occurrenceId, caller)`. The body carries an optional `occurrenceId`, `rating` (1 to 5) and an optional `comment`; when `occurrenceId` is absent the rating is about the whole appointment. The role and the organisation are derived server-side. When the existing row for that occurrence (or whole appointment) and user is soft-deleted, `POST` now answers 409 CONFLICT ("This rating was removed by our moderation team") rather than updating the hidden row and returning 200, because a `GET` already hides a moderated-away row and a 200 here would report a save that nothing shows. No staff surface sets `deletedAt` on this model yet, so the branch currently only guards against a manual write; it is the same shape as the review's `ModeratedReviewError`, ready for the day a removal path exists.

## Edit semantics: `updatedAt` is stamped by the route, not by Prisma

`updatedAt` is `NULL` until the row is edited, and `NULL` means "never touched since it was written". That is strictly more information than a `@default(now())` column would carry, which cannot tell "written and never edited" from "edited within the same second". It also matters for the organisation aggregate, which windows on `createdAt`: a rating created inside the thirty-day window and rewritten from 5 to 1 six months later still reports in that window, and until this column existed nothing could tell that it had moved.

The column is deliberately **not** `@updatedAt`. Prisma stamps that attribute on create as well as on update, so the column could never be `NULL`, and re-submitting an identical rating would move it too. The feedback route sets it explicitly, and only when the rating or the comment actually changed. An absent `comment` in the body means "not supplied", which the upsert already treats as leaving the stored note alone, so it is not an edit either. This is the same "only a changed opinion counts" rule that `ConsultantReview.editedAt` is written by: a double-tapped Save must not read to a moderator as somebody who keeps changing their mind.

## Moderation: soft-delete, and what is still missing

`deletedAt` is `NULL` while the row is live. It has the same semantics and the same reason as `ConsultantReview.deletedAt`: the organisation aggregate and the author's own read filter on `null`, while staff surfaces keep seeing the row. Before the column existed the only way to remove an abusive private comment was a hard `DELETE`, which also destroyed the rating it carried, so a private comment was unreportable, unremovable and unredactable.

Two things are honest to state about the current tree. Nothing writes `deletedAt` yet: no staff route soft-deletes a private rating, so the column is the prerequisite for that control rather than the control itself. And `ModerationReport` still cannot point at an `AppointmentFeedback` row, so a private comment remains unreportable through the report pipe; that is one of the surfaces gathered under #1547.

## Reserved: rating cause and aggregate exclusion on the private rail

`ratingCause` and `excludedFromAggregateAt` are data-model support for the same claim-versus-adjudication split the public review has, so that one Stream outage need not read to an organisation as a bad consultant either — but that is a description of what the columns are for, not a shipped control. No route writes either column yet: nothing asks a rater for a cause, and no staff surface sets the exclusion. What is real today is that the organisation aggregate's `WHERE` already carries the `excludedFromAggregateAt IS NULL` predicate, so the day a staff surface starts writing it, existing rows fall under the filter with no further code change. The reasoning for the taxonomy lives once, in [rating cause and aggregate exclusion](../reviews/04-rating-cause-and-aggregate-exclusion.md).

## Related

- [02-org-quality-signal.md](02-org-quality-signal.md) — what an organisation is shown from these rows.
- [03-schema-reference.md](03-schema-reference.md) — the column list.
- [The grid](../support/02-the-grid.md) — where the private rating sits beside the public review and the support thread.
