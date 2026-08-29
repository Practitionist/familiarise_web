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
  consulteeProfile: {
    id: "consultee-profile-1",
    userId: "user-1",
    user: { name: "Priya S.", image: "https://x/y.png" },
  },
};
const anon = { ...named, isAnonymous: true };

describe("anonymous reviewers", () => {
  it("drops the whole profile, not just the name and avatar", () => {
    const out = stripAnonymousReviewer(anon);
    expect(out.consulteeProfile).toBeNull();
  });

  it("does not leak a stable id that could re-identify the reviewer", () => {
    // The real hazard is CORRELATION, not the name. Review one expert under
    // your name and another anonymously, and a shared consulteeProfile.id in
    // both public payloads joins the two and unmasks the anonymous one. An
    // opaque id stops being opaque the second time it appears.
    const serialised = JSON.stringify(stripAnonymousReviewer(anon));
    expect(serialised).not.toContain("consultee-profile-1");
    expect(serialised).not.toContain("user-1");
    expect(serialised).not.toContain("Priya");
    expect(serialised).not.toContain("y.png");
  });

  it("leaves a named review completely untouched", () => {
    expect(stripAnonymousReviewer(named)).toEqual(named);
  });

  it("keeps everything that is not identifying", () => {
    // The rating still has to count and the review still has to render.
    expect(stripAnonymousReviewer(anon).rating).toBe(5);
    expect(stripAnonymousReviewer(anon).isAnonymous).toBe(true);
  });

  it("still names a NAMED reviewer \u2014 the strip is opt-in, not blanket", () => {
    const out = stripAnonymousReviewer(named);
    expect(JSON.stringify(out)).toContain("Priya S.");
  });

  it("does not mutate the row it was given", () => {
    const row = {
      ...anon,
      consulteeProfile: { ...anon.consulteeProfile },
    };
    stripAnonymousReviewer(row);
    expect(row.consulteeProfile).not.toBeNull();
  });

  it("handles a review with no consultee profile at all", () => {
    const orphan = { isAnonymous: true, consulteeProfile: null };
    expect(() => stripAnonymousReviewer(orphan)).not.toThrow();
  });

  it("strips a mixed list, one by one", () => {
    const out = stripAnonymousReviewers([named, anon]);
    expect(JSON.stringify(out[0])).toContain("Priya S.");
    expect(out[1].consulteeProfile).toBeNull();
  });
});
