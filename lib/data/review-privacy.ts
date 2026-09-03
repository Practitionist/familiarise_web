/**
 * #705 — anonymity has to hold at the API boundary, not in the component.
 *
 * `isAnonymous` is a display choice the reviewer made; stripping the name only
 * where it is rendered would still ship it in the payload, and a public review
 * feed is exactly the thing people read with devtools open. Every public read
 * passes its rows through here, so there is one place to get it right.
 *
 * Authenticity is unaffected — the review is welded to a paid, attended session
 * either way, which is what separates this from the anonymous public reviews
 * Google stepped away from.
 */

/** The shape every public review read shares. */
interface AnonymisableReview {
  isAnonymous: boolean;
  consulteeProfile?: unknown;
}

export function stripAnonymousReviewer<T extends AnonymisableReview>(
  review: T,
): T {
  if (!review.isAnonymous || !review.consulteeProfile) return review;
  // The WHOLE profile goes, not just the name and avatar. Leaving
  // `consulteeProfile.id` behind was a de-anonymisation vector: the same person
  // reviewing one expert under their name and another anonymously shipped the
  // SAME profile id in both public payloads, so the two could be joined and the
  // anonymous one attributed. An opaque id is only opaque until it appears
  // twice.
  return { ...review, consulteeProfile: null };
}

export function stripAnonymousReviewers<T extends AnonymisableReview>(
  reviews: T[],
): T[] {
  return reviews.map(stripAnonymousReviewer);
}
