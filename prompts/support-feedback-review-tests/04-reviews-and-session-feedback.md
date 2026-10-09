# Lane 04 — Reviews and session feedback

> **Required reading:** [`_shared/shared-setup.md`](./_shared/shared-setup.md) and [`_shared/complaint-catalogue.md`](./_shared/complaint-catalogue.md). Output: `{AUDIT_DIR}/04-report.md`.

## Purpose

Exercise the two rating surfaces and what happens downstream of them: the private per-session star rating with an optional private cause, the public review composer with edit history, withdraw and revive, the expert's reply and report controls, the public score gates, and the organisation feedback summary with its small-cohort suppression. The lane protects the score columns of the consultants it touches and restores them exactly.

## Personas and accounts

| Persona | Use |
| --- | --- |
| Customer A | An onboarded consultee with a rateable held occurrence (outcome other than `NOBODY_JOINED`) with Consultant X. Such an account can be a dual-profile account whose pairs include the consultant at the gate. |
| Race customer | Concurrent first saves |
| Consultant X (not at the gate) | Receives the review, replies, reports |
| Consultant Y (at the five-client gate) | Gate and score cases; never reviewed unless restoring is certain |
| Organisation owner | Feedback summary |

## Preconditions and fixture setup

1. From lane 01: eligible pairs without a review, consultants at and below the gate, and the baseline of every score column. Use only pairs whose occurrence is held; a `NOBODY_JOINED` occurrence correctly refuses ratings. If a case needs one of those pairs, record the occurrence outcome, set it to NULL, and restore it in cleanup.
2. Record before values for each consultant you will touch:

```sql
select id, "publishedRatingOneToOne", "publishedRatingGroup", "ratedClientsOneToOne",
       "ratedEventsGroup", "ratingAggregatedAt", "updatedAt"
from "ConsultantProfile" where id in ('<consultant X>','<consultant Y>');
```

3. For the organisation cases, record the original `organizationId` of the `AppointmentFeedback` rows you will tag (normally null on every row) and set it only on rows you list:

```sql
update "AppointmentFeedback" set "organizationId" = '<org id>' where id in (<ids>);
```

4. The private session rating has its own key (`appointment-feedback:`, 5 per hour per user), separate from tickets; public review creation uses `reviewWriteLimiter` (20 per hour) and only `POST` is limited. Run SFR-04-24 and SFR-04-25 last.

## Case table

| ID | Actor | Steps | Expected | Tag |
| --- | --- | --- | --- | --- |
| SFR-04-01 | Customer A, browser | On the session rating row choose 2 stars, then use the keyboard (Space on a cause toggle) to pick a cause. Reload. | A "What could have gone better? (Optional)" fieldset with six toggles exposing `aria-pressed`; the save returns 200; `AppointmentFeedback.ratingCause` holds the value; after reload the toggle is pressed. | [PR-specific] |
| SFR-04-02 | Customer A | Change the rating to 5 stars; also `POST` `rating: 5, ratingCause: "OTHER"` through the API. | The fieldset disappears and `ratingCause` is NULL; the API returns 200 and stores NULL. | [PR-specific] |
| SFR-04-03 | Customer A | Force the cause save to fail by overriding `window.fetch` in the page (for example with `evaluate_script`) so the rating request rejects, then select a new cause. The star mutation reverts on the same failure, so judge only the cause selection. | The toast reports the failure and the selection reverts to the previously saved cause, exactly like a failed star save. The UI never shows an unsaved cause while the database holds the old one. | [PR-specific] |
| SFR-04-04 | Consultant X | `GET` the session feedback as the provider. | Only `id`, `appointmentOccurrenceId`, `rating` and `createdAt`; no comment, no cause; `rateableSlotIds` is empty for the provider. The customer's GET returns the comment and the cause. | [PR-specific] |
| SFR-04-05 | Customer A and race customer | POST a 2 MB body; exceed the write window; send three concurrent first saves for one new session. | 413 "Request body too large"; the sixth write returns 429 `RATE_LIMITED` with `retryAfterSeconds`; the star reverts in the UI and the toast states the true wait; three concurrent first saves return 200 and leave exactly one row. | [PR-specific] |
| SFR-04-06 | Customer A, browser | Create a public review with 3 stars, cause "Timing / scheduling" and text. Reload. Edit only the text and press "Update review". | The cause is pre-selected after reload (the existing-review payload includes `ratingCause`); the text-only edit keeps the stored cause; the revision number increases by one. | [PR-specific] |
| SFR-04-07 | Customer A, API | `PUT /api/user/reviews/<id>` with a new `ratingCause`, then with `rating: 5`. | The cause update is stored; raising the rating above 3 clears the cause, matching the POST behaviour. A PUT never returns 200 while ignoring a field it accepts. | [PR-specific] |
| SFR-04-08 | Customer A | Edit text, edit rating, then resubmit an identical review. Read the public API and profile. | Text edit and rating edit each add a revision row with the prior values; an identical resubmit adds none; the public API shows `editedAt` and the profile shows "Edited"; the expert's inbox shows an edit count. | [SUBSYSTEM] [CX-B5] |
| SFR-04-09 | Customer A | Toggle anonymity; withdraw (DELETE); post again. | Anonymity changes no revision and hides the reviewer's profile publicly; withdraw sets `deletedAt` and `removedBy = AUTHOR` and returns 404 publicly; posting again revives the row without a revision; a second DELETE returns 404 and changes nothing. | [SUBSYSTEM] |
| SFR-04-10 | Customer A, others | Review a session of another user, review as the consultant themself, sign out and review, update another user's review, post rating 6. | 403 with the readable "You can only review a session you attended and paid for" message; 403 for the consultant; 401 anonymous; 403 for another user's review; 400 for rating 6; the profile of a consultant the customer never met shows no composer. | [SUBSYSTEM] |
| SFR-04-11 | Consultant X and Customer A | Consultant creates, edits and deletes a reply; the customer edits the review after the reply; the customer tries to reply. | Reply create and edit work and the edit moves `repliedAt`; a deleted reply is hidden publicly while the body stays with `replyDeletedAt`; the customer's edit after a public reply is flagged `afterPublicReply`; the customer's reply attempt is 403. One public reply per review. | [SUBSYSTEM] [CX-B3] |
| SFR-04-12 | Anyone | Read Consultant Y's public profile and a consultant below the gate. | Y shows "based on N clients" with the one-to-one figure and no blended group number; the one below shows "Not enough rated one-to-one yet" and no zero or blank stars. | [SUBSYSTEM] |
| SFR-04-13 | Anyone | Compare the explore card with the profile for the same consultant. | The card names the basis (one-to-one) and the count, matching the profile. | [SUBSYSTEM] |
| SFR-04-14 | Customer A | Walk the rating UI as a disappointed customer. | The rating is inline and optional; stars are equal in size; there is no modal, nag or confirm-shaming; copy is neutral ("You can edit this later"); there is no sentiment gate before a low rating. | [SUBSYSTEM] [CX-A14] |
| SFR-04-15 | Consultant X, browser | In the reviews inbox use "Report review" and look at the reason picker. | The control exists on every review; the picker includes reasons for coercion or retaliation (not only spam); submission is exercised in lane 05. | [SUBSYSTEM] [CX-B1] |
| SFR-04-16 | Organisation owner | With tagged feedback rows, call the feedback summary at 4 respondents, then 5 (the floor), then 7 in one cohort. | The floor is five respondents. At 4 every figure is null and no consultant is listed; at 5 and 7 the average is correct (verify the arithmetic) and one consultant line appears; the 30-day figure stays hidden whenever one to four older respondents exist, because they would be recoverable by subtraction. | [PR-specific] |
| SFR-04-17 | Organisation owner | Add two cohorts of three respondents, then a third small cohort. | Small cohorts are hidden together, including the larger cohort that would otherwise reveal them; the suppressed count is never exactly one; once hidden people reach the floor the large cohort shows; respondents are counted as people. | [PR-specific] |
| SFR-04-18 | Organisation owner | Set at least five recent respondents to reach the published 30-day branch. | The 30-day average and count are published and agree with the data. | [PR-specific] |
| SFR-04-19 | Consultant X | After a review is created or revived, check the notification. | A notification reaches the expert and is observable (an outbox row or a documented vendor call); if it is not observable, record the limit. | [SUBSYSTEM] |
| SFR-04-20 | Customer A | Create a review, then read the author's view of its status. | The author sees whether the review is published or held, with the reason; a review never silently disappears after submit. | [SUBSYSTEM] [CX-A11] |
| SFR-04-21 | Customer A | Open the rating row for a booking that has an open support ticket or dispute. Ticketed bookings are normally not rateable in the seed, so read the rating row and composer code at the PR head when no live example exists. | The rating prompt is suppressed, or replaced by a gentle "we are looking into your issue" line, while the issue is open. | [SUBSYSTEM] [CX-A12] |
| SFR-04-22 | Customer A | Read the review form for a session where the platform failed (for example a connection problem). | The form separates "the expert" from "the platform" and routes platform problems to support; a low platform-caused rating can be marked as such. | [SUBSYSTEM] [CX-A13] |
| SFR-04-23 | Customer A | Review a group event, if a group example exists. | The group track rates the event, not the one-to-one gate, and appears under its own figure; otherwise NOT RUN with the seed gap. | [SUBSYSTEM] |
| SFR-04-24 | Customer A | Perform 21 public review creations (`POST`) inside one hour. (Run last.) Also send several edits (`PUT`) and a delete. | The twenty-first create returns 429 with `retryAfterSeconds`; the UI shows the true wait. Edit and delete use no limiter today: record that as an observation (PARTIAL), not as a defect of the create limit. | [SUBSYSTEM] |
| SFR-04-25 | Customer A | Rate several sessions until the session-rating key (`appointment-feedback:`, 5 per hour, separate from tickets) returns 429. (Run last.) | The budget is exhausted predictably after five writes; the toast explains the limit in plain words and gives the true wait, so a customer rating many calls of a subscription can tell why. | [SUBSYSTEM] [CX-A15] |
| SFR-04-26 | Anyone | Toggle anonymity and read the public list at once. | The single-review endpoint is correct immediately; the cached list may lag by about two minutes; the report states the lag. | [SUBSYSTEM] |
| SFR-04-27 | Customer A | Keyboard-only walk of the star row, cause toggles and review composer. | Every control is reachable and operable, the star group has an accessible name and value, the fieldset has a legend, and errors are announced. | [SUBSYSTEM] |
| SFR-04-28 | Consultant X | Read an anonymous review in the inbox. | The reviewer's name is hidden from the expert as well; the review text and rating remain. | [SUBSYSTEM] |
| SFR-04-29 | Customer A and Customer B | Submit a 1-star and a 5-star review for the same kind of session and compare publication latency and moderation path. | Equal treatment: both are published on the same path and timing, with no extra gate on low ratings (BIS IS 19000 equal moderation). | [SUBSYSTEM] India BIS IS 19000 |

## Database assertions

- Session rating: `select rating, "ratingCause" from "AppointmentFeedback" where id = '<id>'` after each of SFR-04-01 to SFR-04-07.
- Review revisions: `select "revisionNo", rating, "afterPublicReply" from "ConsultantReviewRevision" where "reviewId" = '<id>' order by "revisionNo"`.
- Score columns after the lane: equal to the recorded originals, including `ratingAggregatedAt`. Verify with a second read after the restore update.
- Organisation summary arithmetic: compute the average in SQL from the tagged rows and compare with the API value.

## Cleanup

Delete `AppointmentFeedback` rows the lane created; delete `ConsultantReview` rows the lane created (revisions are removed with the review, because direct revision deletes are blocked by an immutability trigger); set `organizationId` back to NULL on the rows you tagged; then restore each consultant's score columns with an explicit update to the recorded values and verify. Public pages may serve old scores from cache for about five minutes.

## Report section

Verdict table for SFR-04-01 to SFR-04-29; detail for each FAIL and PARTIAL; psychology notes from the disappointed-customer, expert and organisation-owner points of view; fixtures with before and after score columns.
