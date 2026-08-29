/**
 * @jest-environment node
 */

/**
 * #705 — anonymity has to hold in the PAYLOAD, not in the component.
 *
 * `isAnonymous` is a display choice, but stripping the name only where it is
 * rendered would still ship it over the wire — and the public review feed is
 * CDN-cached and readable by anyone with devtools. The reviewer's protection is
 * only real if the server never sends the name.
 */

import {
  stripAnonymousReviewer,
  stripAnonymousReviewers,
} from "@/lib/data/review-privacy";

const named = {
  isAnonymous: false,
  rating: 5,
  consulteeProfile: { user: { name: "Priya S.", image: "https://x/y.png" } },
};
const anon = { ...named, isAnonymous: true };

describe("anonymous reviewers", () => {
  it("removes the name AND the avatar, not just the name", () => {
    // An avatar is an identifier too, and on a small marketplace often a
    // stronger one than a first name.
    const out = stripAnonymousReviewer(anon);
    expect(out.consulteeProfile.user.name).toBeNull();
    expect(out.consulteeProfile.user.image).toBeNull();
  });

  it("leaves a named review completely untouched", () => {
    expect(stripAnonymousReviewer(named)).toEqual(named);
  });

  it("keeps everything that is not identifying", () => {
    // The rating still has to count and the review still has to render.
    expect(stripAnonymousReviewer(anon).rating).toBe(5);
    expect(stripAnonymousReviewer(anon).isAnonymous).toBe(true);
  });

  it("does not mutate the row it was given", () => {
    const row = { ...anon, consulteeProfile: { user: { ...anon.consulteeProfile.user } } };
    stripAnonymousReviewer(row);
    expect(row.consulteeProfile.user.name).toBe("Priya S.");
  });

  it("handles a review with no consultee profile at all", () => {
    const orphan = { isAnonymous: true, consulteeProfile: null };
    expect(() => stripAnonymousReviewer(orphan)).not.toThrow();
  });

  it("strips a mixed list, one by one", () => {
    const out = stripAnonymousReviewers([named, anon]);
    expect(out[0].consulteeProfile!.user.name).toBe("Priya S.");
    expect(out[1].consulteeProfile!.user.name).toBeNull();
  });
});
