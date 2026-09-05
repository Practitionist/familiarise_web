/**
 * #1485 — the /explore/experts hero used to render fabricated social proof: it
 * fell back to "10K+" experts and a "4.9" rating whenever the real figures were
 * zero (which is the entire pre-launch state), and it rendered a hardcoded
 * "50K+ Sessions Completed" that was never derived from anything at all.
 *
 * These pin the derivation, not the layout: a figure that is not yet meaningful
 * produces no entry, and no entry can ever carry one of the three literals that
 * were there before.
 */

import {
  buildExpertsHeroStats,
  MIN_REVIEWS_FOR_PUBLIC_RATING,
} from "../../app/explore/experts/utils";

const EMPTY = {
  totalConsultants: 0,
  averageRating: 0,
  publishedReviewCount: 0,
  completedSessions: 0,
};

describe("buildExpertsHeroStats", () => {
  it("emits nothing at all when every figure is zero", () => {
    expect(buildExpertsHeroStats(EMPTY)).toEqual([]);
  });

  it("omits the sessions stat when no session has been completed", () => {
    const stats = buildExpertsHeroStats({
      ...EMPTY,
      totalConsultants: 12,
      completedSessions: 0,
    });

    expect(stats.map((s) => s.key)).toEqual(["experts"]);
    expect(stats.some((s) => s.label === "Sessions Completed")).toBe(false);
  });

  it("omits the rating until enough published reviews stand behind it", () => {
    const belowThreshold = buildExpertsHeroStats({
      ...EMPTY,
      averageRating: 4.6,
      publishedReviewCount: MIN_REVIEWS_FOR_PUBLIC_RATING - 1,
    });
    expect(belowThreshold).toEqual([]);

    const atThreshold = buildExpertsHeroStats({
      ...EMPTY,
      averageRating: 4.6,
      publishedReviewCount: MIN_REVIEWS_FOR_PUBLIC_RATING,
    });
    expect(atThreshold).toEqual([
      { key: "rating", value: "4.6", label: "Average Rating" },
    ]);
  });

  it("renders the real figures when they exist", () => {
    const stats = buildExpertsHeroStats({
      totalConsultants: 12,
      averageRating: 4.25,
      publishedReviewCount: 30,
      completedSessions: 87,
    });

    expect(stats).toEqual([
      { key: "experts", value: "12", label: "Active Experts" },
      { key: "rating", value: "4.3", label: "Average Rating" },
      { key: "sessions", value: "87", label: "Sessions Completed" },
    ]);
  });

  // The three literals the page used to render. Two of them were fallbacks that
  // fired precisely when the data was thin, so thin data is where this has to
  // hold. A genuinely measured 4.9 is a different string with the same digits
  // and is allowed — the defect was never the number, it was the invention.
  it("never emits the fabricated literals on the inputs that used to produce them", () => {
    const thin = [
      EMPTY,
      { ...EMPTY, totalConsultants: 1, completedSessions: 1 },
      { ...EMPTY, averageRating: 4.9, publishedReviewCount: 1 },
    ];

    for (const input of thin) {
      for (const stat of buildExpertsHeroStats(input)) {
        expect(["10K+", "4.9", "50K+"]).not.toContain(stat.value);
      }
    }
  });
});
