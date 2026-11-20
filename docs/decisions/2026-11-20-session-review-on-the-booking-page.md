# ADR: A learner writes a session's review on the booking page

- **Status**: Accepted by the owner on 2026-11-20. Ships in the pull request that adds this record.
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [Reviews architecture](../reviews/01-architecture.md#one-review-per-consultant-consultee), [Reviews overview](../reviews/README.md)

## Context

A learner is asked to review a session in two places: the "How was your session with <expert>?" prompt on their Home, and a card on the booking's detail page. Both linked to the expert's public profile (`/explore/experts/<id>#reviews`), where `ProfileReviewComposer` hosts the only review form. The reviews architecture page stated the rule: the appointment page keeps a link rather than a second composer.

The profile page serves only an expert whose `verificationStatus` is `VERIFIED` and who is not deleted (`getConsultantDetail` in `lib/data/consultant-detail.ts`), and answers 404 otherwise. The review route has no such gate: `resolveReviewableSession` in `lib/reviews.ts` accepts any session the learner held and paid for. So a learner whose expert is still `PENDING_VERIFICATION` was sent to a 404 and could not write a review the route would have accepted.

## Worked example

Daniel Brown held a career consultation with Michael Anderson, whose profile is `PENDING_VERIFICATION`. Before, Daniel's Home showed "How was your session with Michael Anderson?", and its Rate link opened a 404. Now Rate opens `/dashboard/consultee/<Daniel's profile>/appointments/<booking>#review`, the booking page scrolls to the review form, and Daniel posts five stars. The message reads "Saved. It will appear on Michael Anderson's public profile once that profile is live." When Michael is verified, the review shows on his profile with the others. Before posting, the form says "Public — it will appear on their profile once it is live.", and the booking page offers no "Book again". Had Michael been verified already, the form and the message would say it appears on his profile, and "Book again" would open it.

## Decisions

1. **The booking page hosts the review form.** `components/reviews/SessionReviewCard.tsx` asks `GET /api/user/reviews/reviewable-sessions?appointmentId=<id>` and renders `ReviewComposer` only when the route answers with that session. The route that authorises the write also decides whether the form shows, so the page and the POST cannot disagree. This reverses the rule that the appointment page keeps a link rather than a second composer.
2. **Home's Rate prompt links to that form.** `deriveConsulteeActionItems` in `lib/dashboard/action-items.ts` builds `<dashboard>/appointments/<appointmentId>#review` (`SESSION_REVIEW_ANCHOR`). The profile's own form is unchanged.
3. **The public form stays apart from the private stars.** The booking page also shows the private per-session rating (`SessionRatingRow`, stored as `AppointmentFeedback`). The review form's heading ("Write a review of <expert>") and its "Public" line say which one it is, so neither reads as a copy of the other.
4. **Every promise of the profile follows one fact.** `isPublicExpertProfile` in `lib/profiles/public-profile.ts` is the profile page's own gate (`VERIFIED` and not deleted). The reviewable-sessions answer and `POST /api/user/reviews` each carry it as `profileIsPublic`, read from the expert row their query already joins. The form's line under its heading, the message after posting and Home's card body say the review appears on the profile only when it is true, and otherwise that it will appear once the profile is live. The verification status itself is never sent to the browser.
5. **The booking page links to the profile only when it is served.** `readAppointmentDetail` returns `expertProfileIsPublic`, computed from the plan's expert in the same joined read, and strips the two fields it was read from. "Book again", "Continue with <expert>" and the trial's next-step card render only when it is true; a learner of an unverified expert sees none of them rather than a link to a 404.
6. **Eligibility, moderation and profile visibility do not change.** A review of an unverified expert's session was already accepted; this only gives the learner a way to write it.

## Consequences

- An operator, or an organisation admin looking at someone else's booking, sees no review card: the route answers for the signed-in person's own sessions.
- A review of an unverified expert counts toward their score from the moment it is written. The profile shows it once the expert is verified.
