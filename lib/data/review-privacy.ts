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
  consulteeProfile?: {
    user?: { name?: string | null; image?: string | null } | null;
  } | null;
}

export function stripAnonymousReviewer<T extends AnonymisableReview>(
  review: T,
): T {
  if (!review.isAnonymous || !review.consulteeProfile) return review;
  return {
    ...review,
    consulteeProfile: {
      ...review.consulteeProfile,
      user: {
        ...review.consulteeProfile.user,
        name: null,
        image: null,
      },
    },
  };
}

export function stripAnonymousReviewers<T extends AnonymisableReview>(
  reviews: T[],
): T[] {
  return reviews.map(stripAnonymousReviewer);
}
